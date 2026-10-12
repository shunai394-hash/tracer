import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";
import { getOrderSkuLookup, resolveShopifyOrderSkus } from "@/lib/shopify/order-sku-mapping";

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
  let cleanupDb: ReturnType<typeof createSupabaseAdminClient> | null = null;
  let cleanupOrderId: string | null = null;
  let cleanupExternalId: string | null = null;
  try {
    const order = JSON.parse(raw) as Record<string, unknown>;
    const externalId = String(order.id ?? "");
    if (!externalId) return NextResponse.json({ ok: false, error: "shopify_order_id_missing" }, { status: 400 });

    const db = createSupabaseAdminClient();
    cleanupDb = db;
    cleanupExternalId = externalId;
    const existing = await db.from("shop_orders").select("id").eq("shopify_order_id", externalId).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) return NextResponse.json({ ok: true, duplicate: true, orderId: String(existing.data.id) });

    const items = Array.isArray(order.line_items) ? order.line_items as Array<Record<string, unknown>> : [];
    const skus = items.map((item) => String(item.sku ?? "").trim());
    // Validate every line before creating a parent order; otherwise a missing
    // SKU on a later line could leave a partial order record behind.
    if (!items.length || skus.some((sku) => !sku)) {
      return NextResponse.json({ ok: true, blocked: true, reason: "listing_sku_missing" });
    }

    // Shopify SKUs are generated as TRC-<supplier_variant_id>, falling back
    // to supplier_product_id and finally listing.id. Do not treat the SKU itself
    // as shop_listings.id: resolve its exact stable identity first.
    const lookup = getOrderSkuLookup(skus);
    const listingSelect = "id,product_id,title,published,orderable,selling_price,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id";
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
    // Deduplicate rows returned by multiple identity queries.
    const listings = [...new Map(candidateRows.map((row) => [String(row.id), row])).values()];
    const resolution = resolveShopifyOrderSkus(skus, listings);
    if (!resolution.ok) {
      return NextResponse.json({ ok: true, blocked: true, reason: resolution.reason, sku: resolution.sku });
    }
    const bySku = resolution.bySku;
    if (skus.some((sku) => {
      const listing = bySku.get(sku);
      return !listing || listing.published !== true || listing.orderable !== true;
    })) {
      return NextResponse.json({ ok: true, blocked: true, reason: "listing_not_orderable" });
    }

    const financial = String(order.financial_status ?? "pending");
    const paid = financial === "paid";
    const shipping = (order.shipping_address ?? {}) as Record<string, unknown>;
    const customer = (order.customer ?? {}) as Record<string, unknown>;
    const billing = (order.billing_address ?? {}) as Record<string, unknown>;
    const currency = String(order.currency ?? order.presentment_currency ?? "JPY");
    const inserted = await db.from("shop_orders").insert({
      listing_id: bySku.get(skus[0])?.id ?? null,
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
      subtotal: n(order.subtotal_price),
      shipping_cost: null,
      total: n(order.total_price),
      currency,
      metadata: { source: "shopify_webhook", shopify_order_id: externalId },
      shopify_order_id: externalId,
      shopify_order_number: order.order_number == null ? null : String(order.order_number),
      shopify_financial_status: financial,
      shopify_fulfillment_status: order.fulfillment_status ? String(order.fulfillment_status) : null,
    }).select("id").single();
    if (inserted.error) throw new Error(inserted.error.message);
    cleanupOrderId = String(inserted.data.id);

    // Insert each order item only after mapping has been validated. If any
    // insert fails, the catch block removes all children and the parent so a
    // Shopify retry cannot be mistaken for a fully imported duplicate.
    for (const [index, item] of items.entries()) {
      // Use the same normalized SKU used during resolution; Shopify payloads may
      // contain surrounding whitespace even though lookup keys are trimmed.
      const listing = bySku.get(skus[index]);
      if (!listing) throw new Error("listing mapping missing during item insert");
      const row = await db.from("shop_order_items").insert({
        order_id: inserted.data.id,
        listing_id: listing.id,
        product_id: listing.product_id,
        supplier_listing_id: listing.supplier_listing_id ?? null,
        supplier_name: listing.supplier_name ?? null,
        supplier_product_id: listing.supplier_product_id ?? null,
        supplier_variant_id: listing.supplier_variant_id ?? null,
        title: String(item.title ?? listing.title),
        qty: n(item.quantity) ?? 0,
        unit_price: n(item.price) ?? n(listing.selling_price),
        currency,
        shopify_line_item_id: item.id == null ? null : String(item.id),
      });
      if (row.error) throw new Error(row.error.message);
    }

    return NextResponse.json({ ok: true, orderId: String(inserted.data.id), paid });
  } catch (error) {
    if (cleanupDb && cleanupOrderId && cleanupExternalId) {
      const childCleanup = await cleanupDb.from("shop_order_items").delete().eq("order_id", cleanupOrderId);
      const parentCleanup = await cleanupDb.from("shop_orders").delete()
        .eq("id", cleanupOrderId)
        .eq("shopify_order_id", cleanupExternalId);
      if (childCleanup.error || parentCleanup.error) {
        console.error("[TRACER SHOPIFY ORDER WEBHOOK ROLLBACK ERROR]", {
          orderId: cleanupOrderId,
          shopifyOrderId: cleanupExternalId,
          childCleanupFailed: Boolean(childCleanup.error),
          parentCleanupFailed: Boolean(parentCleanup.error),
        });
      }
    }
    console.error("[TRACER SHOPIFY ORDER WEBHOOK ERROR]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
