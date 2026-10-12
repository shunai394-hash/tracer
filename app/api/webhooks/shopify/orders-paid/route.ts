import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";
import { syncPaidShopifyOrders } from "@/lib/shopify/sync-orders";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhookHmac(rawBody, hmac)) {
    return NextResponse.json({ ok: false, error: "invalid_webhook_signature" }, { status: 401 });
  }

  const webhookId = request.headers.get("x-shopify-webhook-id")?.trim();
  const topic = request.headers.get("x-shopify-topic")?.trim() || "orders/paid";
  const orderId = request.headers.get("x-shopify-order-id")?.trim() || null;
  if (!webhookId) {
    return NextResponse.json({ ok: false, error: "missing_webhook_id" }, { status: 400 });
  }
  if (topic !== "orders/paid") {
    return NextResponse.json({ ok: false, error: "unsupported_webhook_topic" }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "invalid_webhook_payload" }, { status: 400 });
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_webhook_json" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { error: insertError } = await supabase
    .from("shopify_webhook_events")
    .insert({
      shopify_event_id: webhookId,
      topic,
      shopify_order_id: orderId,
      payload,
    });

  let retryingUnprocessedEvent = false;
  if (insertError?.code === "23505") {
    // A duplicate delivery is only complete when the stored event says so.
    // Failed/incomplete events must not be silently acknowledged as finished.
    const { data: prior, error: priorError } = await supabase
      .from("shopify_webhook_events")
      .select("processed, processing_error")
      .eq("shopify_event_id", webhookId)
      .maybeSingle();
    if (priorError) {
      return NextResponse.json({ ok: false, error: "shopify_webhook_event_read_failed" }, { status: 500 });
    }
    if (!prior) {
      return NextResponse.json({ ok: false, error: "shopify_webhook_event_missing_after_conflict" }, { status: 500 });
    }
    if (prior.processed === true) {
      return NextResponse.json({ ok: true, duplicate: true, processed: true });
    }
    retryingUnprocessedEvent = true;
  } else if (insertError) {
    return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
  }

  try {
    const imported = await syncPaidShopifyOrders(25);
    if (!imported.configured) {
      throw new Error("shopify_sync_not_configured");
    }
    if (imported.failed > 0) {
      throw new Error(
        "shopify_order_import_failed:" +
        imported.errors.map((item) => `${item.shopifyOrderId}=${item.error}`).join("; ").slice(0, 1500),
      );
    }

    const { data: marked, error: markError } = await supabase
      .from("shopify_webhook_events")
      .update({ processed: true, processed_at: new Date().toISOString(), processing_error: null })
      .eq("shopify_event_id", webhookId)
      .select("shopify_event_id")
      .maybeSingle();
    if (markError) throw new Error("shopify_webhook_event_mark_processed_failed:" + markError.message);
    if (!marked) throw new Error("shopify_webhook_event_missing_when_marking_processed");

    return NextResponse.json({
      ok: true,
      imported: imported.imported,
      skipped: imported.skipped,
      orderIds: imported.orderIds,
      retrying: retryingUnprocessedEvent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { error: persistError } = await supabase
      .from("shopify_webhook_events")
      .update({ processed: false, processing_error: message.slice(0, 2000) })
      .eq("shopify_event_id", webhookId);
    if (persistError) {
      console.error("[SHOPIFY WEBHOOK ERROR PERSIST FAILED]", {
        webhookId,
        processingError: message,
        persistenceError: persistError.message,
      });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
