import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhookHmac } from "@/lib/shopify/admin";
import { getOrderSkuLookup, resolveShopifyOrderSkus } from "@/lib/shopify/order-sku-mapping";
import { createDropshipPurchaseOrdersForShopOrder } from "@/lib/ordering/dropship";

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
    const existing = await db.from("shop_orders").select("id,payment_status,order_status").eq("shopify_order_id", externalId).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      const financial = String(order.financial_status ?? "pending");
      const paid = financial === "paid";
      let paymentStatus = String(existing.data.payment_status ?? "");
      if (paid && paymentStatus !== "paid") {
        const { error: paymentUpdateError } = await db
          .from("shop_orders")
          .update({
            payment_status: "paid",
            order_status: "fulfillment_pending",
            paid_at: new Date().toISOString(),
            shopify_financial_status: financial,
            shopify_fulfillment_status: order.fulfillment_status ? String(order.fulfillment_status) : null,
          })
          .eq("id", existing.data.id)
          .neq("payment_status", "paid");
        if (paymentUpdateError) throw new Error(paymentUpdateError.message);
        paymentStatus = "paid";
      }
      // Shopify may deliver a later paid/update event for the same order ID.
      // Retry the idempotent PO snapshot step for paid orders rather than
      // acknowledging a duplicate while leaving procurement uninitialized.
      if (paid || paymentStatus === "paid") {
        await createDropshipPurchaseOrdersForShopOrder(String(existing.data.id));
      }
      return NextResponse.json({ ok: true, duplicate: true, orderId: String(existing.data.id), paid: paid || paymentStatus === "paid" });
    }

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

    // Re-check the canonical supplier row at order ingestion. A stale shop_listings
    // orderable flag is not sufficient proof that this variant is safe to procure.
    const resolvedListings = skus.map((sku) => bySku.get(sku)!);
    const supplierListingIds = [...new Set(resolvedListings.map((listing) => listing.supplier_listing_id).filter((id): id is string => Boolean(id)))];
    if (supplierListingIds.length !== new Set(resolvedListings.map((listing) => listing.id)).size) {
      return NextResponse.json({ ok: true, blocked: true, reason: "supplier_identity_missing" });
    }
    const { data: supplierRows, error: supplierRowsError } = await db
      .from("supplier_listings")
      .select("id,product_id,supplier,supplier_product_id,supplier_variant_id,identity_status,verification_status,orderable,api_available,tracking_available,price_confirmed,inventory_confirmed,inventory,cost,shipping_cost")
      .in("id", supplierListingIds);
    if (supplierRowsError) throw new Error(supplierRowsError.message);
    const supplierById = new Map((supplierRows ?? []).map((row) => [String(row.id), row]));
    const requestedBySupplierListing = new Map<string, number>();
    for (const [index, item] of items.entries()) {
      const listing = bySku.get(skus[index]);
      const supplier = listing?.supplier_listing_id ? supplierById.get(listing.supplier_listing_id) : null;
      const quantity = n(item.quantity);
      const inventory = n(supplier?.inventory);
      const sourceCost = n(supplier?.cost);
      const shippingCost = n(supplier?.shipping_cost);
      const valid =
        Boolean(listing && supplier) &&
        supplier?.identity_status === "linked" &&
        supplier?.verification_status === "verified" &&
        supplier?.orderable === true &&
        supplier?.api_available === true &&
        supplier?.tracking_available === true &&
        supplier?.price_confirmed === true &&
        supplier?.inventory_confirmed === true &&
        Boolean(supplier?.supplier_product_id) &&
        Boolean(supplier?.supplier_variant_id) &&
        String(supplier?.supplier_product_id) === String(listing?.supplier_product_id) &&
        String(supplier?.supplier_variant_id) === String(listing?.supplier_variant_id) &&
        String(supplier?.product_id ?? "") === String(listing?.product_id ?? "") &&
        Number.isFinite(quantity) && quantity! > 0 &&
        Number.isFinite(inventory) && inventory! > 0 &&
        Number.isFinite(sourceCost) && sourceCost! > 0 &&
        Number.isFinite(shippingCost) && shippingCost! >= 0;
      if (!valid) {
        return NextResponse.json({
          ok: true,
          blocked: true,
          reason: "supplier_fulfillment_gate_failed",
          sku: skus[index],
        });
      }
      const supplierListingId = String(listing!.supplier_listing_id);
      requestedBySupplierListing.set(
        supplierListingId,
        (requestedBySupplierListing.get(supplierListingId) ?? 0) + quantity!,
      );
    }
    // Aggregate duplicate lines for the same canonical supplier row. Checking
    // each line separately would let two quantities individually pass while
    // their combined quantity oversells the confirmed inventory.
    for (const [supplierListingId, requestedQuantity] of requestedBySupplierListing) {
      const supplier = supplierById.get(supplierListingId);
      const inventory = n(supplier?.inventory);
      if (inventory === null || requestedQuantity > inventory) {
        const sku = resolvedListings.find((listing) => listing.supplier_listing_id === supplierListingId)
          ? skus[resolvedListings.findIndex((listing) => listing.supplier_listing_id === supplierListingId)]
          : undefined;
        return NextResponse.json({
          ok: true,
          blocked: true,
          reason: "supplier_inventory_insufficient",
          ...(sku ? { sku } : {}),
        });
      }
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

    const itemRows = items.map((item, index) => {
      // Use the same normalized SKU used during resolution; Shopify payloads may
      // contain surrounding whitespace even though lookup keys are trimmed.
      const listing = bySku.get(skus[index]);
      if (!listing) throw new Error("listing mapping missing during item insert");
      return {
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
      };
    });
    const itemInsert = await db.from("shop_order_items").insert(itemRows);
    if (itemInsert.error) {
      // Do not leave a parent order that causes webhook retries to be treated
      // as complete when its line items were not persisted.
      const { error: cleanupError } = await db.from("shop_orders").delete().eq("id", inserted.data.id).eq("shopify_order_id", externalId);
      if (cleanupError) console.error("[TRACER SHOPIFY ORDER CLEANUP ERROR]", cleanupError.message);
      throw new Error(`shop_order_items_insert_failed:${itemInsert.error.message}`);
    }

    if (paid) {
      // This creates idempotent internal purchase-order snapshots only; actual
      // supplier execution remains separately gated and disabled unless enabled.
      await createDropshipPurchaseOrdersForShopOrder(String(inserted.data.id));
    }

    return NextResponse.json({ ok: true, orderId: String(inserted.data.id), paid });
  } catch (error) {
    console.error("[TRACER SHOPIFY ORDER WEBHOOK ERROR]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
