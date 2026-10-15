import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";
import { getOrderSkuLookup } from "@/lib/shopify/order-sku-mapping";
import { resolveShopifyOrderLines, shopifyLineIdentity } from "@/lib/ordering/shopify-line-match";
import { validateShopifyOrderFinancials } from "@/lib/ordering/shopify-order-financials";

export const runtime = "nodejs";

function n(value: unknown): number | null {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyShopifyWebhookHmac(raw, request.headers.get("x-shopify-hmac-sha256"))) {
    return NextResponse.json({ ok: false, error: "invalid_webhook_signature" }, { status: 401 });
  }
  try {
    const order = JSON.parse(raw) as Record<string, unknown>;
    const externalId = String(order.id ?? "");
    if (!externalId) return NextResponse.json({ ok: false, error: "shopify_order_id_missing" }, { status: 400 });

    const items = Array.isArray(order.line_items) ? order.line_items as Array<Record<string, unknown>> : [];
    const financials = validateShopifyOrderFinancials(order, items);
    if (!financials.ok) {
      return NextResponse.json({ ok: true, blocked: true, reason: financials.reason }, { status: 422 });
    }

    const db = createSupabaseAdminClient();
    const lines = items.map((item) => shopifyLineIdentity({ sku: item.sku, variant_id: item.variant_id }));
    const skus = lines.map((line) => line.sku);
    // Each line needs at least one stable identity: the generated SKU or the
    // Shopify variant id recorded when TRACER synced the product.
    if (!items.length || lines.some((line) => !line.sku && line.shopifyVariantIds.length === 0)) {
      return NextResponse.json({ ok: true, blocked: true, reason: "listing_sku_missing" });
    }
    // Stable Shopify line IDs are required to repair partial imports without
    // duplicating order items when Shopify retries a webhook.
    if (items.some((item) => item.id == null || !String(item.id).trim())) {
      return NextResponse.json({ ok: true, blocked: true, reason: "shopify_line_item_id_missing" });
    }

    const existing = await db.from("shop_orders").select("id").eq("shopify_order_id", externalId).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    const existingOrderId = existing.data ? String(existing.data.id) : null;
    const existingLineItemIds = new Set<string>();
    if (existingOrderId) {
      const { data: existingItems, error: existingItemsError } = await db
        .from("shop_order_items")
        .select("shopify_line_item_id")
        .eq("order_id", existingOrderId);
      if (existingItemsError) throw new Error(existingItemsError.message);
      for (const row of existingItems ?? []) {
        if (typeof row.shopify_line_item_id === "string" && row.shopify_line_item_id) {
          existingLineItemIds.add(row.shopify_line_item_id);
        }
      }
      const incomingLineIds = items.map((item) => String(item.id));
      if (incomingLineIds.every((id) => existingLineItemIds.has(id))) {
        return NextResponse.json({ ok: true, duplicate: true, orderId: existingOrderId });
      }
      // Legacy rows without stable Shopify IDs cannot be safely auto-repaired:
      // avoid duplicating them or guessing which incoming line they represent.
      if ((existingItems ?? []).some((row) => !row.shopify_line_item_id)) {
        return NextResponse.json({
          ok: true,
          blocked: true,
          reason: "existing_order_items_legacy_id_missing",
          orderId: existingOrderId,
        }, { status: 409 });
      }
    }

    // Shopify SKUs are generated as TRC-<supplier_variant_id>, falling back
    // to supplier_product_id and finally listing.id. Do not treat the SKU itself
    // as shop_listings.id: resolve its exact stable identity first.
    const lookup = getOrderSkuLookup(skus.filter(Boolean));
    const listingSelect = "id,product_id,title,published,orderable,selling_price,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id,shopify_variant_id";
    type ListingRow = {
      id: string;
      product_id: string;
      title: string;
      published: boolean;
      orderable: boolean;
      selling_price: number | string | null;
      supplier_listing_id: string | null;
      supplier_name: string | null;
      supplier_product_id: string | null;
      supplier_variant_id: string | null;
      shopify_variant_id: string | null;
    };
    const candidateRows: ListingRow[] = [];
    if (lookup.supplierSources.length) {
      const [byVariant, byProduct] = await Promise.all([
        db.from("shop_listings").select(listingSelect).in("supplier_variant_id", lookup.supplierSources),
        db.from("shop_listings").select(listingSelect).in("supplier_product_id", lookup.supplierSources),
      ]);
      if (byVariant.error) throw new Error(byVariant.error.message);
      if (byProduct.error) throw new Error(byProduct.error.message);
      candidateRows.push(...(byVariant.data ?? []), ...(byProduct.data ?? []));
    }
    if (lookup.legacyListingIds.length) {
      const legacy = await db.from("shop_listings").select(listingSelect).in("id", lookup.legacyListingIds);
      if (legacy.error) throw new Error(legacy.error.message);
      candidateRows.push(...(legacy.data ?? []));
    }
    // The Shopify variant id is independent evidence: it can map a line that
    // has no SKU, and it exposes a SKU that points at a different listing.
    const shopifyVariantIds = [...new Set(lines.flatMap((line) => line.shopifyVariantIds))];
    if (shopifyVariantIds.length) {
      const byShopifyVariant = await db.from("shop_listings").select(listingSelect).in("shopify_variant_id", shopifyVariantIds);
      if (byShopifyVariant.error) throw new Error(byShopifyVariant.error.message);
      candidateRows.push(...(byShopifyVariant.data ?? []));
    }
    // Deduplicate rows returned by multiple identity queries.
    const listings = [...new Map(candidateRows.map((row) => [String(row.id), row])).values()];
    const resolution = resolveShopifyOrderLines(lines, listings);
    if (!resolution.ok) {
      return NextResponse.json({ ok: true, blocked: true, reason: resolution.reason, sku: resolution.sku, line: resolution.lineIndex });
    }
    const byLine = resolution.listings;
    if (!existingOrderId && byLine.some((listing) => listing.published !== true || listing.orderable !== true)) {
      return NextResponse.json({ ok: true, blocked: true, reason: "listing_not_orderable" });
    }

    const financial = String(order.financial_status ?? "pending");
    const paid = financial === "paid";
    const shipping = (order.shipping_address ?? {}) as Record<string, unknown>;
    const customer = (order.customer ?? {}) as Record<string, unknown>;
    const billing = (order.billing_address ?? {}) as Record<string, unknown>;
    let orderId = existingOrderId;
    if (!orderId) {
      const inserted = await db.from("shop_orders").insert({
        listing_id: byLine[0]?.id ?? null,
        status: "placed",
        payment_method: "shopify",
        payment_status: paid ? "paid" : "pending",
        order_status: paid ? "fulfillment_pending" : "pending_payment",
        paid_at: paid ? new Date().toISOString() : null,
        customer_name: String(billing.name ?? customer.first_name ?? "Shopify customer"),
        customer_email: String(order.email ?? customer.email ?? ""),
        customer_phone: shipping.phone ? String(shipping.phone) : null,
        shipping_address: String(shipping.address1 ?? ""),
        shipping_country_code: shipping.country_code ? String(shipping.country_code) : null,
        shipping_province: shipping.province ? String(shipping.province) : null,
        shipping_city: shipping.city ? String(shipping.city) : null,
        shipping_zip: shipping.zip ? String(shipping.zip) : null,
        shipping_line1: shipping.address1 ? String(shipping.address1) : null,
        subtotal: financials.subtotal,
        shipping_cost: null,
        total: financials.total,
        currency: financials.currency,
        metadata: { source: "shopify_webhook", shopify_order_id: externalId },
        shopify_order_id: externalId,
        shopify_order_name: String(order.name ?? order.order_number ?? ""),
        shopify_financial_status: financial,
        shopify_fulfillment_status: order.fulfillment_status ? String(order.fulfillment_status) : null,
      }).select("id").single();
      if (inserted.error) throw new Error(inserted.error.message);
      orderId = String(inserted.data.id);
    }

    for (const [index, item] of items.entries()) {
      // Same per-line resolution used above (SKU and/or Shopify variant id).
      const listing = byLine[index];
      if (!listing) throw new Error("listing mapping missing during item insert");
      const lineItemId = String(item.id);
      if (existingLineItemIds.has(lineItemId)) continue;
      const itemPayload = {
        order_id: orderId,
        listing_id: listing.id,
        product_id: listing.product_id,
        supplier_listing_id: listing.supplier_listing_id ?? null,
        supplier_name: listing.supplier_name ?? null,
        supplier_product_id: listing.supplier_product_id ?? null,
        supplier_variant_id: listing.supplier_variant_id ?? null,
        title: String(item.title ?? listing.title),
        qty: financials.lineAmounts[index].quantity,
        unit_price: financials.lineAmounts[index].unitPrice,
        currency: financials.currency,
        shopify_line_item_id: lineItemId,
      };
      const row = await db.from("shop_order_items").insert(itemPayload).select("id").single();
      if (row.error) {
        // Concurrent webhook retries may race on the unique Shopify line ID.
        // Treat it as idempotent only if the winning row belongs to this order.
        const { data: lineItem, error: lookupError } = await db
          .from("shop_order_items")
          .select("order_id")
          .eq("shopify_line_item_id", lineItemId)
          .maybeSingle();
        if (lookupError) throw new Error(lookupError.message);
        if (lineItem && String(lineItem.order_id) === orderId) {
          existingLineItemIds.add(lineItemId);
          continue;
        }
        throw new Error(`shop_order_items_insert_failed:${row.error.message}`);
      }
      existingLineItemIds.add(lineItemId);
    }

    return NextResponse.json({ ok: true, orderId, paid, repaired: Boolean(existingOrderId) });
  } catch (error) {
    console.error("[TRACER SHOPIFY ORDER WEBHOOK ERROR]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
