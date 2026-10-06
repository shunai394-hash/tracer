import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";

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

    const db = createSupabaseAdminClient();
    const existing = await db.from("shop_orders").select("id").eq("shopify_order_id", externalId).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) return NextResponse.json({ ok: true, duplicate: true, orderId: String(existing.data.id) });

    const items = Array.isArray(order.line_items) ? order.line_items as Array<Record<string, unknown>> : [];
    const skus = items.map((item) => String(item.sku ?? "")).filter(Boolean);
    if (!items.length || !skus.length) return NextResponse.json({ ok: true, blocked: true, reason: "listing_sku_missing" });

    const { data: listings, error: listingError } = await db.from("shop_listings")
      .select("id,product_id,title,published,orderable,selling_price,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id")
      .in("id", skus);
    if (listingError) throw new Error(listingError.message);
    const byId = new Map((listings ?? []).map((row) => [String(row.id), row]));
    if (skus.some((sku) => !byId.has(sku))) return NextResponse.json({ ok: true, blocked: true, reason: "listing_mapping_missing" });
    if ((listings ?? []).some((row) => row.published !== true || row.orderable !== true)) {
      return NextResponse.json({ ok: true, blocked: true, reason: "listing_not_orderable" });
    }

    const financial = String(order.financial_status ?? "pending");
    const paid = financial === "paid";
    const shipping = (order.shipping_address ?? {}) as Record<string, unknown>;
    const customer = (order.customer ?? {}) as Record<string, unknown>;
    const billing = (order.billing_address ?? {}) as Record<string, unknown>;
    const currency = String(order.currency ?? order.presentment_currency ?? "JPY");
    const inserted = await db.from("shop_orders").insert({
      listing_id: byId.get(skus[0])?.id ?? null,
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

    for (const item of items) {
      const listing = byId.get(String(item.sku ?? ""));
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
    console.error("[TRACER SHOPIFY ORDER WEBHOOK ERROR]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
