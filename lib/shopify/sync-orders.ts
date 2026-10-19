import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";
import { ingestPaidOrder } from "@/lib/commerce/core";

type ShopifyOrder = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  createdAt: string;
  cancelledAt: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  shippingAddress: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    countryCodeV2: string | null;
    phone: string | null;
  } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      quantity: number;
      originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      variant: { id: string; sku: string | null } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type ShopifyOrderSyncResult = {
  configured: boolean;
  fetched: number;
  imported: number;
  skipped: number;
  failed: number;
  orderIds: string[];
  errors: Array<{ shopifyOrderId: string; error: string }>;
};

function canonicalShopifyId(value: string, resource: "Order" | "LineItem"): string {
  const prefix = "gid://shopify/" + resource + "/";
  const id = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!/^\d+$/.test(id)) throw new Error("shopify_" + resource.toLowerCase() + "_id_invalid");
  return id;
}

function isTracerManagedSku(value: unknown): boolean {
  const sku = String(value ?? "").trim().toUpperCase();
  return sku.startsWith("TRC-") || sku.startsWith("CJ-");
}

function finitePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function syncPaidShopifyOrders(limit = 25): Promise<ShopifyOrderSyncResult> {
  if (!isShopifyConfigured()) {
    return { configured: false, fetched: 0, imported: 0, skipped: 0, failed: 0, orderIds: [], errors: [] };
  }

  const supabase = createSupabaseAdminClient();
  const maxNewOrders = Math.min(Math.max(limit, 1), 100);
  const orders: ShopifyOrder[] = [];
  let scannedOrders = 0;
  let after: string | null = null;
  let hasNextOrdersPage = true;

  // Polling must use the same canonical order ledger as the paid webhook.
  // Do not create a second legacy order that can trigger a duplicate purchase.
  while (hasNextOrdersPage && orders.length < maxNewOrders) {
    const data: {
      orders: {
        nodes: ShopifyOrder[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await shopifyGraphQL<{
      orders: {
        nodes: ShopifyOrder[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(
      `query PaidOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, query: "financial_status:paid fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: true) {
          nodes {
            id name email phone displayFinancialStatus displayFulfillmentStatus createdAt cancelledAt
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { name address1 address2 city province zip country countryCodeV2 phone }
            lineItems(first: 100) {
              nodes { id title quantity originalUnitPriceSet { shopMoney { amount currencyCode } } variant { id sku } }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: 100, after },
    );

    const pageOrders: ShopifyOrder[] = data.orders.nodes ?? [];
    scannedOrders += pageOrders.length;
    if (pageOrders.length > 0) {
      const { data: existingRows, error: existingRowsError } = await supabase
        .from("commerce_orders")
        .select("external_order_id,fulfillment_status")
        .eq("channel", "shopify")
        .in("external_order_id", pageOrders.map((order) => canonicalShopifyId(order.id, "Order")));
      if (existingRowsError) throw new Error("shopify_canonical_order_lookup_failed:" + existingRowsError.message);
      const existingById = new Map((existingRows ?? []).map((row) => [
        String(row.external_order_id), String(row.fulfillment_status ?? ""),
      ]));
      for (const order of pageOrders) {
        const knownStatus = existingById.get(canonicalShopifyId(order.id, "Order"));
        // Revisit canonical orders awaiting procurement so corrected address,
        // supplier stock, or offer evidence can be reconciled by an idempotent poll.
        if ((!knownStatus || knownStatus === "procurement_pending") && orders.length < maxNewOrders) orders.push(order);
      }
    }

    hasNextOrdersPage = data.orders.pageInfo.hasNextPage;
    const nextCursor: string | null = data.orders.pageInfo.endCursor;
    if (hasNextOrdersPage && (!nextCursor || nextCursor === after)) {
      throw new Error("shopify_orders_cursor_not_advancing");
    }
    after = nextCursor;
  }

  for (const order of orders) {
    let cursor = order.lineItems.pageInfo.endCursor;
    let hasNextPage = order.lineItems.pageInfo.hasNextPage;
    while (hasNextPage) {
      if (!cursor) throw new Error("shopify_line_items_cursor_missing:" + order.id);
      const nextPage = await shopifyGraphQL<{
        order: {
          lineItems: {
            nodes: ShopifyOrder["lineItems"]["nodes"];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      }>(
        `query PaidOrderLineItems($id: ID!, $first: Int!, $after: String!) {
          order(id: $id) {
            lineItems(first: $first, after: $after) {
              nodes { id title quantity originalUnitPriceSet { shopMoney { amount currencyCode } } variant { id sku } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: order.id, first: 100, after: cursor },
      );
      const connection = nextPage.order?.lineItems;
      if (!connection) throw new Error("shopify_line_items_page_missing:" + order.id);
      order.lineItems.nodes.push(...connection.nodes);
      const nextCursor: string | null = connection.pageInfo.endCursor;
      if (connection.pageInfo.hasNextPage && (!nextCursor || nextCursor === cursor)) {
        throw new Error("shopify_line_items_cursor_not_advancing:" + order.id);
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      cursor = nextCursor;
    }

    const seenLineItemIds = new Set<string>();
    for (const item of order.lineItems.nodes) {
      if (seenLineItemIds.has(item.id)) throw new Error("shopify_line_item_duplicate_id:" + order.id + ":" + item.id);
      seenLineItemIds.add(item.id);
    }
  }

  const result: ShopifyOrderSyncResult = {
    configured: true, fetched: scannedOrders, imported: 0, skipped: 0, failed: 0, orderIds: [], errors: [],
  };
  const tracerItemsByOrder = new Map<string, ShopifyOrder["lineItems"]["nodes"]>();
  const variantIds = Array.from(new Set(
    orders.flatMap((order) => {
      const tracerItems = order.lineItems.nodes.filter((item) => isTracerManagedSku(item.variant?.sku));
      tracerItemsByOrder.set(order.id, tracerItems);
      return tracerItems.map((item) => item.variant?.id).filter((id): id is string => Boolean(id));
    }),
  ));

  const tracerSkus = Array.from(new Set(
    orders.flatMap((order) => (tracerItemsByOrder.get(order.id) ?? [])
      .map((item) => String(item.variant?.sku ?? "").trim()).filter(Boolean)),
  ));
  const { data: listings, error: listingError } = variantIds.length
    ? await supabase.from("channel_listings")
        .select("variant_id,external_variant_id,external_sku,status")
        .eq("channel", "shopify").eq("status", "published")
        .in("external_variant_id", variantIds)
    : { data: [], error: null };
  if (listingError) throw new Error("shopify_canonical_listing_lookup_failed:" + listingError.message);
  const { data: skuListings, error: skuListingError } = tracerSkus.length
    ? await supabase.from("channel_listings")
        .select("variant_id,external_variant_id,external_sku,status")
        .eq("channel", "shopify").eq("status", "published")
        .in("external_sku", tracerSkus)
    : { data: [], error: null };
  if (skuListingError) throw new Error("shopify_canonical_sku_lookup_failed:" + skuListingError.message);

  const listingByExternalVariant = new Map<string, { variantId: string; sku: string }>();
  const listingBySku = new Map<string, { variantId: string; sku: string }>();
  for (const row of [...(listings ?? []), ...(skuListings ?? [])]) {
    const variantId = String(row.variant_id ?? "").trim();
    const sku = String(row.external_sku ?? "").trim();
    const externalVariantId = String(row.external_variant_id ?? "").trim();
    const mapped = { variantId, sku };
    if (externalVariantId && variantIds.includes(externalVariantId)) {
      const existing = listingByExternalVariant.get(externalVariantId);
      if (existing && existing.variantId !== variantId) throw new Error("shopify_variant_mapping_ambiguous:" + externalVariantId);
      listingByExternalVariant.set(externalVariantId, mapped);
    }
    if (sku && tracerSkus.includes(sku)) {
      const existing = listingBySku.get(sku);
      if (existing && existing.variantId !== variantId) throw new Error("shopify_sku_mapping_ambiguous:" + sku);
      listingBySku.set(sku, mapped);
    }
  }

  const internalVariantIds = Array.from(new Set([
    ...[...listingByExternalVariant.values(), ...listingBySku.values()].map((row) => row.variantId),
  ]));
  const { data: prices, error: priceError } = internalVariantIds.length
    ? await supabase.from("commerce_prices").select("variant_id,supplier_offer_id").in("variant_id", internalVariantIds)
    : { data: [], error: null };
  if (priceError) throw new Error("shopify_canonical_price_lookup_failed:" + priceError.message);
  const offerByVariant = new Map<string, string>();
  for (const row of prices ?? []) {
    const variantId = String(row.variant_id);
    const offerId = String(row.supplier_offer_id ?? "");
    if (!offerId) continue;
    if (offerByVariant.has(variantId) && offerByVariant.get(variantId) !== offerId) {
      throw new Error("shopify_variant_supplier_offer_ambiguous:" + variantId);
    }
    offerByVariant.set(variantId, offerId);
  }

  for (const order of orders) {
    try {
      if (order.cancelledAt || order.displayFinancialStatus !== "PAID" || order.displayFulfillmentStatus !== "UNFULFILLED") {
        result.skipped += 1;
        continue;
      }
      const tracerItems = tracerItemsByOrder.get(order.id) ?? [];
      if (!tracerItems.length) {
        result.skipped += 1;
        continue;
      }
      // Keep the paid order even when address fields need repair; procurement
      // records the block and refuses any external supplier call until complete.
      const address = order.shippingAddress;
      const total = finitePositiveNumber(order.totalPriceSet.shopMoney.amount);
      if (total === null) throw new Error("shopify_total_invalid");

      const canonicalLines = tracerItems.map((item) => {
        if (!item.variant?.id || !isTracerManagedSku(item.variant.sku)) {
          throw new Error("shopify_tracer_variant_id_or_sku_missing:" + item.id);
        }
        const listing = listingByExternalVariant.get(item.variant.id)
          ?? listingBySku.get(String(item.variant.sku ?? "").trim());
        if (!listing) throw new Error("shopify_canonical_variant_not_mapped:" + item.variant.sku);
        const offerId = offerByVariant.get(listing.variantId);
        if (!offerId) throw new Error("shopify_canonical_supplier_offer_missing:" + item.variant.sku);
        const quantity = Number(item.quantity);
        const unitPrice = finitePositiveNumber(item.originalUnitPriceSet.shopMoney.amount);
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("shopify_line_item_quantity_invalid:" + item.id);
        if (unitPrice === null || !item.originalUnitPriceSet.shopMoney.currencyCode) {
          throw new Error("shopify_line_item_price_or_currency_invalid:" + item.id);
        }
        return {
          externalLineId: canonicalShopifyId(item.id, "LineItem"),
          variantId: listing.variantId,
          sku: listing.sku || item.variant.sku,
          quantity,
          unitPrice: Math.round(unitPrice),
          offerId,
        };
      });

      const imported = await ingestPaidOrder({
        channel: "shopify",
        externalOrderId: canonicalShopifyId(order.id, "Order"),
        totalAmount: Math.round(total),
        customerName: address?.name || order.email || null,
        shippingAddress: {
          country: address?.country ?? "",
          country_code: address?.countryCodeV2 ?? "",
          country_code_v2: address?.countryCodeV2 ?? "",
          province: address?.province ?? "",
          city: address?.city ?? "",
          address1: address?.address1 ?? "",
          address2: address?.address2 ?? "",
          zip: address?.zip ?? "",
          phone: address?.phone || order.phone || "",
          email: order.email ?? "",
        },
        rawPayload: {
          source: "shopify_paid_order_poll",
          name: order.name,
          createdAt: order.createdAt,
          currency: order.totalPriceSet.shopMoney.currencyCode,
          displayFinancialStatus: order.displayFinancialStatus,
          displayFulfillmentStatus: order.displayFulfillmentStatus,
        },
        lines: canonicalLines,
      });
      if (imported.duplicate) result.skipped += 1;
      else result.imported += 1;
      result.orderIds.push(imported.orderId);
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        shopifyOrderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
