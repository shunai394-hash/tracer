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

  if (insertError?.code === "23505") {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  if (insertError) {
    return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
  }

  try {
    const imported = await syncPaidShopifyOrders(25);
    await supabase
      .from("shopify_webhook_events")
      .update({ processed: true, processed_at: new Date().toISOString(), processing_error: null })
      .eq("shopify_event_id", webhookId);

    return NextResponse.json({ ok: true, imported: imported.imported, orderIds: imported.orderIds });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("shopify_webhook_events")
      .update({ processing_error: message.slice(0, 2000) })
      .eq("shopify_event_id", webhookId);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
