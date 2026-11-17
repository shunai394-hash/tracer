import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";
import { ingestPaidOrder } from "@/lib/commerce/core";
import { shopifyVariantIdCandidates } from "@/lib/shopify/order-sku-mapping";

export const runtime = "nodejs";

type ShopifyLine = { id?: string | number; variant_id?: string | number | null; sku?: string | null; quantity?: number; price?: string | number; title?: string };
type CanonicalSupplierLine = { externalLineId: string; variantId: string; sku: string; quantity: number; unitPrice: number; offerId: string };
type CanonicalManualLine = { externalLineId: string; variantId: string; sku: string; quantity: number };
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
    const supplierLines: CanonicalSupplierLine[] = [];
    const manualLines: CanonicalManualLine[] = [];
    for (const line of lines) {
      const sku = String(line.sku ?? "").trim();
      if (!isTracerManagedSku(sku)) continue; // Ignore unrelated items in a mixed cart.
      const quantity = Number(line.quantity);
      const unitPrice = Number(line.price);
      if (!line.id || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error("invalid_tracer_line_item");
      }
      let listingRows: Array<{ variant_id: string }> = [];
      const rawShopifyVariantId = String(line.variant_id ?? "").trim();
      if (rawShopifyVariantId) {
        const candidateIds = shopifyVariantIdCandidates(rawShopifyVariantId);
        if (candidateIds.length === 0) throw new Error("tracer_shopify_variant_id_invalid:" + rawShopifyVariantId);
        const currentByVariant = await db.from("channel_listings")
          .select("variant_id").eq("channel", "shopify").eq("status", "published")
          .in("external_variant_id", candidateIds);
        if (currentByVariant.error) throw new Error("tracer_variant_mapping_read_failed:" + currentByVariant.error.message);
        listingRows = currentByVariant.data ?? [];
        if (listingRows.length === 0) {
          const aliasByVariant = await db.from("channel_listing_external_aliases")
            .select("variant_id").eq("channel", "shopify").in("external_variant_id", candidateIds);
          if (aliasByVariant.error) throw new Error("tracer_variant_alias_lookup_failed:" + aliasByVariant.error.message);
          listingRows = aliasByVariant.data ?? [];
        }
        if (listingRows.length === 0) throw new Error("tracer_variant_mapping_missing:" + rawShopifyVariantId);
      } else {
        const exact = await db.from("channel_listings")
          .select("variant_id").eq("channel", "shopify").eq("external_sku", sku).eq("status", "published");
        if (exact.error) throw new Error("tracer_sku_mapping_read_failed:" + exact.error.message);
        listingRows = exact.data ?? [];
      }
      let legacyOfferId: string | null = null;
      if (listingRows.length === 0) {
        const normalizedSku = sku.toUpperCase();
        const legacySupplierVariantId = sku.slice(normalizedSku.startsWith("CJ-") ? 3 : 4).trim();
        if (legacySupplierVariantId) {
          const legacyOffers = await db.from("supplier_offers")
            .select("id,variant_id").eq("supplier_variant_id", legacySupplierVariantId)
            .eq("source_status", "verified").eq("tracking_supported", true).eq("ship_to", "JP").gt("inventory", 0);
          if (legacyOffers.error) throw new Error("legacy_supplier_variant_lookup_failed:" + legacyOffers.error.message);
          const offers = legacyOffers.data ?? [];
          const variantIds = [...new Set(offers.map((offer) => String(offer.variant_id ?? "")).filter(Boolean))];
          if (variantIds.length > 1) throw new Error("tracer_sku_mapping_ambiguous:" + sku);
          if (variantIds.length === 1) {
            const legacyListings = await db.from("channel_listings")
              .select("variant_id").eq("channel", "shopify").eq("status", "published").eq("variant_id", variantIds[0]);
            if (legacyListings.error) throw new Error("legacy_channel_listing_lookup_failed:" + legacyListings.error.message);
            listingRows = legacyListings.data ?? [];
            const offersForVariant = offers.filter((offer) => String(offer.variant_id) === variantIds[0]);
            if (offersForVariant.length === 1) legacyOfferId = String(offersForVariant[0].id);
            else if (offersForVariant.length > 1) throw new Error("supplier_offer_mapping_ambiguous:" + sku);
          }
        }
      }
      const uniqueVariantIds = [...new Set(listingRows.map((row) => String(row.variant_id ?? "")).filter(Boolean))];
      if (uniqueVariantIds.length === 0) throw new Error("tracer_sku_mapping_missing:" + sku);
      if (uniqueVariantIds.length > 1) throw new Error("tracer_sku_mapping_ambiguous:" + sku);
      const variantId = uniqueVariantIds[0];

      // TRACER-owned inventory has no supplier offer. Route it to its own
      // reservation + fulfillment queue; never create a supplier purchase order.
      const { data: manualListing, error: manualError } = await db.from("shop_listings")
        .select("id,manual_inventory,published,archived_at").eq("id", variantId).maybeSingle();
      if (manualError) throw new Error("manual_stock_listing_read_failed:" + manualError.message);
      if (manualListing?.manual_inventory === true) {
        if (manualListing.published !== true || manualListing.archived_at) throw new Error("manual_stock_listing_not_sellable:" + sku);
        manualLines.push({ externalLineId: String(line.id), variantId, sku, quantity });
        continue;
      }

      const { data: price, error: priceError } = await db.from("commerce_prices")
        .select("supplier_offer_id").eq("variant_id", variantId).maybeSingle();
      if (priceError || (!legacyOfferId && !price?.supplier_offer_id)) throw new Error("supplier_offer_mapping_missing:" + sku);
      supplierLines.push({
        externalLineId: String(line.id), variantId, sku,
        quantity, unitPrice: Math.round(unitPrice), offerId: legacyOfferId ?? String(price!.supplier_offer_id)
      });
    }

    if (supplierLines.length === 0 && manualLines.length === 0) {
      await db.from("shopify_webhook_events").update({ processed: true, processed_at: new Date().toISOString(), processing_error: null }).eq("shopify_event_id", webhookId);
      return NextResponse.json({ ok: true, ignored: true, reason: "no_tracer_line_items" });
    }

    const customer = payload.customer;
    const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim() || null;
    let supplierOrder: { orderId: string; duplicate: boolean } | null = null;
    if (supplierLines.length > 0) {
      supplierOrder = await ingestPaidOrder({
        channel: "shopify", externalOrderId: String(payload.id),
        totalAmount: Math.round(Number(payload.total_price ?? 0)), customerName,
        shippingAddress: payload.shipping_address && typeof payload.shipping_address === "object" ? payload.shipping_address : {},
        rawPayload: payload, lines: supplierLines
      });
    }

    // The orders/create webhook must have persisted the local order and line IDs
    // first. If it has not, fail so Shopify retries; never fabricate customer PII.
    if (manualLines.length > 0) {
      const { data: localOrder, error: orderReadError } = await db.from("shop_orders")
        .select("id").eq("shopify_order_id", String(payload.id)).maybeSingle();
      if (orderReadError) throw new Error("manual_stock_order_read_failed:" + orderReadError.message);
      if (!localOrder) throw new Error("manual_stock_local_order_not_imported");
      const lineIds = manualLines.map((line) => line.externalLineId);
      const { data: localItems, error: itemsReadError } = await db.from("shop_order_items")
        .select("id,listing_id,shopify_line_item_id").eq("order_id", localOrder.id).in("shopify_line_item_id", lineIds);
      if (itemsReadError) throw new Error("manual_stock_order_items_read_failed:" + itemsReadError.message);
      const itemsByLine = new Map((localItems ?? []).map((item) => [String(item.shopify_line_item_id), item]));
      for (const line of manualLines) {
        const item = itemsByLine.get(line.externalLineId);
        if (!item || String(item.listing_id) !== line.variantId) {
          throw new Error("manual_stock_order_item_mapping_missing:" + line.externalLineId);
        }
        const { data: reservation, error: reserveError } = await db.rpc("reserve_shopify_manual_stock", {
          p_shopify_order_id: String(payload.id), p_shopify_line_item_id: line.externalLineId,
          p_listing_id: line.variantId, p_quantity: line.quantity
        });
        if (reserveError || !reservation?.reservation_id) {
          throw new Error("manual_stock_reservation_failed:" + (reserveError?.message ?? "missing_reservation_id"));
        }
        const workItem = {
          reservation_id: String(reservation.reservation_id), shop_order_id: String(localOrder.id),
          shop_order_item_id: String(item.id), listing_id: line.variantId,
          shopify_order_id: String(payload.id), shopify_line_item_id: line.externalLineId,
          quantity: line.quantity
        };
        const { error: queueError } = await db.from("shopify_manual_fulfillment_work_items")
          .upsert(workItem, { onConflict: "shopify_line_item_id", ignoreDuplicates: true });
        if (queueError) throw new Error("manual_fulfillment_queue_write_failed:" + queueError.message);
        const { data: savedWorkItem, error: verifyQueueError } = await db.from("shopify_manual_fulfillment_work_items")
          .select("reservation_id,shop_order_id,shop_order_item_id,listing_id,quantity")
          .eq("shopify_line_item_id", line.externalLineId).single();
        if (verifyQueueError || !savedWorkItem ||
            String(savedWorkItem.reservation_id) !== workItem.reservation_id ||
            String(savedWorkItem.shop_order_id) !== workItem.shop_order_id ||
            String(savedWorkItem.shop_order_item_id) !== workItem.shop_order_item_id ||
            String(savedWorkItem.listing_id) !== workItem.listing_id ||
            Number(savedWorkItem.quantity) !== workItem.quantity) {
          throw new Error("manual_fulfillment_queue_identity_conflict:" + line.externalLineId);
        }
      }
    }

    const { error: finishError } = await db.from("shopify_webhook_events")
      .update({ processed: true, processed_at: new Date().toISOString(), processing_error: null })
      .eq("shopify_event_id", webhookId);
    if (finishError) throw new Error("webhook_completion_save_failed:" + finishError.message);
    return NextResponse.json({
      ok: true, orderId: supplierOrder?.orderId ?? null, duplicate: supplierOrder?.duplicate ?? false,
      supplierLines: supplierLines.length, procurementIntents: supplierLines.length,
      manualLines: manualLines.length, fulfillmentWorkItems: manualLines.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("shopify_webhook_events").update({ processing_error: message.slice(0, 2000) }).eq("shopify_event_id", webhookId);
    return NextResponse.json({ ok: false, error: message }, { status: 422 });
  }
}
