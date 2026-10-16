import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";
import { ingestPaidOrder } from "@/lib/commerce/core";

export const runtime = "nodejs";

type ShopifyLine = { id?: string | number; sku?: string | null; quantity?: number; price?: string | number; title?: string };
type ShopifyPayload = Record<string, unknown> & {
  id?: string | number; name?: string; total_price?: string | number;
  customer?: { first_name?: string; last_name?: string } | null;
  shipping_address?: Record<string, unknown> | null;
  line_items?: ShopifyLine[];
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!verifyShopifyWebhookHmac(rawBody, request.headers.get("x-shopify-hmac-sha256"))) {
    return NextResponse.json({ ok: false, error: "invalid_webhook_signature" }, { status: 401 });
  }
  const webhookId = request.headers.get("x-shopify-webhook-id")?.trim();
  const topic = request.headers.get("x-shopify-topic")?.trim() || "orders/paid";
  if (!webhookId) return NextResponse.json({ ok: false, error: "missing_webhook_id" }, { status: 400 });
  if (topic !== "orders/paid") return NextResponse.json({ ok: false, error: "unsupported_webhook_topic" }, { status: 400 });

  let payload: ShopifyPayload;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    payload = parsed as ShopifyPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_webhook_json" }, { status: 400 });
  }
  if (payload.id === undefined || payload.id === null) {
    return NextResponse.json({ ok: false, error: "shopify_order_id_missing" }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const { error: insertError } = await db.from("shopify_webhook_events").insert({
    shopify_event_id: webhookId, topic, shopify_order_id: String(payload.id), payload
  });
  if (insertError && insertError.code !== "23505") {
    return NextResponse.json({ ok: false, error: "webhook_event_persist_failed:" + insertError.message }, { status: 500 });
  }
  if (insertError?.code === "23505") {
    const { data: prior, error: priorError } = await db.from("shopify_webhook_events")
      .select("processed,processing_error").eq("shopify_event_id", webhookId).maybeSingle();
    if (priorError) return NextResponse.json({ ok: false, error: "webhook_retry_state_read_failed" }, { status: 500 });
    if (prior?.processed === true) return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    const lines = Array.isArray(payload.line_items) ? payload.line_items : [];
    const canonicalLines: Array<{ externalLineId: string; variantId: string; sku: string; quantity: number; unitPrice: number; offerId: string }> = [];
    for (const line of lines) {
      const sku = String(line.sku ?? "").trim();
      if (!sku.startsWith("TRC-")) continue; // Ignore unrelated items in a mixed cart.
      const quantity = Number(line.quantity);
      const unitPrice = Number(line.price);
      if (!line.id || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error("invalid_tracer_line_item");
      }
      const { data: listing, error: listingError } = await db.from("channel_listings")
        .select("variant_id").eq("channel", "shopify").eq("external_sku", sku).eq("status", "published").maybeSingle();
      if (listingError || !listing) throw new Error("tracer_sku_mapping_missing:" + sku);
      const { data: price, error: priceError } = await db.from("commerce_prices")
        .select("supplier_offer_id").eq("variant_id", listing.variant_id).maybeSingle();
      if (priceError || !price?.supplier_offer_id) throw new Error("supplier_offer_mapping_missing:" + sku);
      canonicalLines.push({
        externalLineId: String(line.id), variantId: String(listing.variant_id), sku,
        quantity, unitPrice: Math.round(unitPrice * 100) / 100, offerId: String(price.supplier_offer_id)
      });
    }
    if (canonicalLines.length === 0) {
      await db.from("shopify_webhook_events").update({ processed: true, processed_at: new Date().toISOString(), processing_error: null }).eq("shopify_event_id", webhookId);
      return NextResponse.json({ ok: true, ignored: true, reason: "no_tracer_line_items" });
    }
    const customer = payload.customer;
    const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim() || null;
    const order = await ingestPaidOrder({
      channel: "shopify", externalOrderId: String(payload.id),
      totalAmount: Math.round(Number(payload.total_price ?? 0) * 100) / 100,
      customerName,
      shippingAddress: payload.shipping_address && typeof payload.shipping_address === "object" ? payload.shipping_address : {},
      rawPayload: payload,
      lines: canonicalLines
    });
    const { error: finishError } = await db.from("shopify_webhook_events")
      .update({ processed: true, processed_at: new Date().toISOString(), processing_error: null })
      .eq("shopify_event_id", webhookId);
    if (finishError) throw new Error("webhook_completion_save_failed:" + finishError.message);
    return NextResponse.json({ ok: true, orderId: order.orderId, duplicate: order.duplicate, lines: canonicalLines.length, procurementIntents: canonicalLines.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("shopify_webhook_events").update({ processing_error: message.slice(0, 2000) }).eq("shopify_event_id", webhookId);
    return NextResponse.json({ ok: false, error: message }, { status: 422 });
  }
}
