import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";
import { ingestPaidOrder } from "@/lib/commerce/core";

export const runtime = "nodejs";

type ShopifyLine = { id?: string | number; sku?: string | null; variant_id?: string | number | null; variant_title?: string | null; quantity?: number; price?: string | number; title?: string };
function isTracerManagedSku(value: unknown): boolean {
  const sku = String(value ?? "").trim().toUpperCase();
  return sku.startsWith("TRC-") || sku.startsWith("CJ-");
}

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
    const canonicalLines: Array<{ externalLineId: string; variantId: string; sku: string; quantity: number; unitPrice: number; offerId: string; selection: Record<string, unknown> }> = [];
    for (const line of lines) {
      const sku = String(line.sku ?? "").trim();
      if (!isTracerManagedSku(sku)) continue; // Ignore unrelated items in a mixed cart.
      const quantity = Number(line.quantity);
      const unitPrice = Number(line.price);
      if (!line.id || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error("invalid_tracer_line_item");
      }
      // Prefer the exact SKU saved by the publisher. Older Shopify listings may
      // still carry TRC-<supplier_variant_id> or CJ-<supplier_variant_id>; resolve only through an exact,
      // verified supplier-offer identity, never by title or partial SKU.
      const shopifyVariantGid = line.variant_id === undefined || line.variant_id === null || !String(line.variant_id).trim()
        ? null
        : "gid://shopify/ProductVariant/" + String(line.variant_id).trim();
      let gidVariantId: string | null = null;
      if (shopifyVariantGid) {
        const byGid = await db.from("channel_listings")
          .select("variant_id").eq("channel", "shopify").eq("external_variant_id", shopifyVariantGid).eq("status", "published");
        if (byGid.error) throw new Error("tracer_variant_mapping_read_failed:" + byGid.error.message);
        const gidIds = [...new Set((byGid.data ?? []).map((row) => String(row.variant_id ?? "")).filter(Boolean))];
        if (gidIds.length > 1) throw new Error("tracer_sku_mapping_ambiguous:" + sku);
        gidVariantId = gidIds[0] ?? null;
      }
      const exact = await db.from("channel_listings")
        .select("variant_id").eq("channel", "shopify").eq("external_sku", sku).eq("status", "published");
      if (exact.error) throw new Error("tracer_sku_mapping_read_failed:" + exact.error.message);
      let listingRows = exact.data ?? [];
      let legacyOfferId: string | null = null;
      if (listingRows.length === 0 && isTracerManagedSku(sku)) {
        const normalizedSku = sku.toUpperCase();
        const legacySupplierVariantId = sku.slice(normalizedSku.startsWith("CJ-") ? 3 : 4).trim();
        if (legacySupplierVariantId) {
          const legacyOffers = await db.from("supplier_offers")
            .select("id,variant_id")
            .eq("supplier_variant_id", legacySupplierVariantId)
            .eq("source_status", "verified")
            .eq("tracking_supported", true)
            .eq("ship_to", "JP")
            .gt("inventory", 0);
          if (legacyOffers.error) throw new Error("legacy_supplier_variant_lookup_failed:" + legacyOffers.error.message);
          const offers = legacyOffers.data ?? [];
          const variantIds = [...new Set(offers.map((offer) => String(offer.variant_id ?? "")).filter(Boolean))];
          if (variantIds.length > 1) throw new Error("tracer_sku_mapping_ambiguous:" + sku);
          if (variantIds.length === 1) {
            const legacyListings = await db.from("channel_listings")
              .select("variant_id").eq("channel", "shopify").eq("status", "published")
              .eq("variant_id", variantIds[0]);
            if (legacyListings.error) throw new Error("legacy_channel_listing_lookup_failed:" + legacyListings.error.message);
            listingRows = legacyListings.data ?? [];
            const offersForVariant = offers.filter((offer) => String(offer.variant_id) === variantIds[0]);
            if (offersForVariant.length === 1) legacyOfferId = String(offersForVariant[0].id);
            else if (offersForVariant.length > 1) throw new Error("supplier_offer_mapping_ambiguous:" + sku);
          }
        }
      }
      const uniqueVariantIds = [...new Set(listingRows.map((row) => String(row.variant_id ?? "")).filter(Boolean))];
      if (!gidVariantId && uniqueVariantIds.length === 0) throw new Error("tracer_sku_mapping_missing:" + sku);
      if (uniqueVariantIds.length > 1) throw new Error("tracer_sku_mapping_ambiguous:" + sku);
      if (gidVariantId && uniqueVariantIds.length === 1 && gidVariantId !== uniqueVariantIds[0]) throw new Error("tracer_sku_mapping_ambiguous:" + sku);
      const variantId = gidVariantId ?? uniqueVariantIds[0];
      const { data: price, error: priceError } = await db.from("commerce_prices")
        .select("supplier_offer_id").eq("variant_id", variantId).maybeSingle();
      if (priceError || (!legacyOfferId && !price?.supplier_offer_id)) throw new Error("supplier_offer_mapping_missing:" + sku);
      canonicalLines.push({
        externalLineId: String(line.id), variantId, sku,
        quantity, unitPrice: Math.round(unitPrice), offerId: legacyOfferId ?? String(price!.supplier_offer_id),
        selection: { channel: "shopify", variantTitle: line.variant_title ?? null, shopifyVariantId: shopifyVariantGid, sku },
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
      totalAmount: Math.round(Number(payload.total_price ?? 0)),
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
