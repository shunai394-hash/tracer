import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";
import { uniqueRowsByKey } from "@/lib/ordering/channel-listing-match";
import { createDropshipPurchaseOrdersForShopOrder } from "@/lib/ordering/dropship";
import { shopifyOrderIdForms, shopifyOrderNumericId } from "@/lib/shopify/order-id";

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

function fullAddress(address: ShopifyOrder["shippingAddress"]): string {
  if (!address) return "";
  return [
    address.zip,
    address.country,
    address.province,
    address.city,
    address.address1,
    address.address2,
  ].filter(Boolean).join(" ");
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

  // Search newest paid orders first and skip orders already imported. Without
  // this outer pagination, the same first page can starve all later orders.
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
        orders(first: $first, after: $after, query: "financial_status:paid status:open fulfillment_status:unfulfilled", sortKey: CREATED_AT, reverse: true) {
          nodes {
            id name email phone displayFinancialStatus displayFulfillmentStatus createdAt cancelledAt
            totalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { name address1 address2 city province zip country countryCodeV2 phone }
            lineItems(first: 100) {
              nodes {
                id title quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                variant { id sku }
              }
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
        .from("shop_orders")
        .select("shopify_order_id")
        .in("shopify_order_id", pageOrders.flatMap((order) => shopifyOrderIdForms(order.id)));
      if (existingRowsError) throw new Error(existingRowsError.message);
      // Compare numeric tails: the REST webhook once stored numeric ids.
      const existingIds = new Set((existingRows ?? []).map((row) => shopifyOrderNumericId(row.shopify_order_id)));
      for (const order of pageOrders) {
        if (!existingIds.has(shopifyOrderNumericId(order.id)) && orders.length < maxNewOrders) orders.push(order);
      }
    }

    hasNextOrdersPage = data.orders.pageInfo.hasNextPage;
    const nextCursor: string | null = data.orders.pageInfo.endCursor;
    if (hasNextOrdersPage && (!nextCursor || nextCursor === after)) {
      throw new Error("shopify_orders_cursor_not_advancing");
    }
    after = nextCursor;
  }

  // Shopify paginates nested lineItems independently from the orders connection.
  // Resolve every page before any local DB read/write so a cursor failure cannot
  // leave a partial order that looks imported.
  for (const order of orders) {
    let after = order.lineItems.pageInfo.endCursor;
    let hasNextPage = order.lineItems.pageInfo.hasNextPage;
    while (hasNextPage) {
      if (!after) throw new Error(`shopify_line_items_cursor_missing:${order.id}`);
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
              nodes {
                id title quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                variant { id sku }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: order.id, first: 100, after },
      );
      const connection = nextPage.order?.lineItems;
      if (!connection) throw new Error(`shopify_line_items_page_missing:${order.id}`);
      order.lineItems.nodes.push(...connection.nodes);
      const nextCursor = connection.pageInfo.endCursor;
      if (connection.pageInfo.hasNextPage && (!nextCursor || nextCursor === after)) {
        throw new Error(`shopify_line_items_cursor_not_advancing:${order.id}`);
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      after = nextCursor;
    }

    const seenLineItemIds = new Set<string>();
    for (const item of order.lineItems.nodes) {
      if (seenLineItemIds.has(item.id)) throw new Error(`shopify_line_item_duplicate_id:${order.id}:${item.id}`);
      seenLineItemIds.add(item.id);
    }
  }

  const result: ShopifyOrderSyncResult = {
    configured: true,
    fetched: scannedOrders,
    imported: 0,
    skipped: 0,
    failed: 0,
    orderIds: [],
    errors: [],
  };
  const variantIds = Array.from(new Set(
    orders.flatMap((order) => order.lineItems.nodes.map((item) => item.variant?.id).filter(Boolean)),
  ));
  const { data: listings, error: listingError } = variantIds.length
    ? await supabase
        .from("shop_listings")
        .select("id,product_id,title,shopify_product_id,shopify_variant_id,supplier_listing_id,supplier_name,supplier_variant_id,supplier_product_id")
        .in("shopify_variant_id", variantIds)
    : { data: [], error: null };
  if (listingError) throw new Error(listingError.message);

  const matchedListings = uniqueRowsByKey(listings ?? [], (row) => row.shopify_variant_id ? String(row.shopify_variant_id) : null);
  const ambiguousVariants = new Set(matchedListings.ambiguousKeys);
  const listingByVariant = matchedListings.unique;

  for (const order of orders) {
    let insertedOrderId: string | null = null;
    try {
      // Do not turn a cancelled, partially fulfilled, or already fulfilled
      // Shopify order into a new procurement job. Query filters are backed by
      // explicit response checks because supplier execution is irreversible.
      if (order.cancelledAt) {
        result.skipped += 1;
        continue;
      }
      if (order.displayFinancialStatus !== "PAID") {
        result.skipped += 1;
        continue;
      }
      if (order.displayFulfillmentStatus !== "UNFULFILLED") {
        result.skipped += 1;
        continue;
      }

      const { data: existing, error: existingError } = await supabase
        .from("shop_orders")
        .select("id")
        .in("shopify_order_id", shopifyOrderIdForms(order.id))
        .limit(1)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existing) {
        result.skipped += 1;
        result.orderIds.push(String(existing.id));
        await createDropshipPurchaseOrdersForShopOrder(String(existing.id));
        continue;
      }

      const address = fullAddress(order.shippingAddress);
      const customerName = order.shippingAddress?.name || order.email || "Shopify customer";
      const customerEmail = order.email || "shopify-order@invalid.local";
      const phone = order.shippingAddress?.phone || order.phone || null;
      const total = finitePositiveNumber(order.totalPriceSet.shopMoney.amount);
      if (total === null) throw new Error("shopify_total_invalid");
      if (!address) throw new Error("shopify_shipping_address_missing");
      if (!order.lineItems.nodes.length) throw new Error("shopify_line_items_missing");

      const ambiguousItems = order.lineItems.nodes.filter((item) => item.variant?.id && ambiguousVariants.has(item.variant.id));
      if (ambiguousItems.length) {
        throw new Error(`shopify_variant_mapping_ambiguous:${ambiguousItems.map((item) => item.variant?.id).join(",")}`);
      }
      const mappedItems = order.lineItems.nodes.map((item) => {
        const listing = item.variant?.id ? listingByVariant.get(item.variant.id) : undefined;
        return { item, listing };
      });
      const unmapped = mappedItems.filter(({ listing }) => !listing);
      if (unmapped.length) {
        throw new Error(`shopify_variant_not_mapped:${unmapped.map(({ item }) => item.variant?.sku || item.id).join(",")}`);
      }

      for (const { item } of mappedItems) {
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
          throw new Error(`shopify_line_item_quantity_invalid:${item.id}`);
        }
        if (finitePositiveNumber(item.originalUnitPriceSet.shopMoney.amount) === null) {
          throw new Error(`shopify_line_item_price_invalid:${item.id}`);
        }
        if (!item.originalUnitPriceSet.shopMoney.currencyCode) {
          throw new Error(`shopify_line_item_currency_missing:${item.id}`);
        }
      }

      const primaryListing = mappedItems[0]?.listing;
      const inserted = await supabase
        .from("shop_orders")
        .insert({
          listing_id: primaryListing?.id ?? null,
          status: "placed",
          payment_method: "shopify",
          payment_status: "paid",
          order_status: "fulfillment_pending",
          customer_name: customerName,
          customer_email: customerEmail,
          customer_phone: phone,
          shipping_address: address,
          subtotal: total,
          shipping_cost: 0,
          total,
          currency: order.totalPriceSet.shopMoney.currencyCode,
          shipping_country_code: order.shippingAddress?.countryCodeV2 ?? null,
          shipping_province: order.shippingAddress?.province ?? null,
          shipping_city: order.shippingAddress?.city ?? null,
          shipping_line1: order.shippingAddress?.address1 ?? null,
          shipping_line2: order.shippingAddress?.address2 ?? null,
          shipping_zip: order.shippingAddress?.zip ?? null,
          notes: `Shopify ${order.name}`,
          shopify_order_id: order.id,
          shopify_order_name: order.name,
          shopify_fulfillment_status: order.displayFulfillmentStatus,
          shopify_financial_status: order.displayFinancialStatus,
          shopify_synced_at: new Date().toISOString(),
          paid_at: new Date().toISOString(),
          metadata: {
            source: "shopify",
            created_at: order.createdAt,
            country_code: order.shippingAddress?.countryCodeV2,
          },
        })
        .select("id")
        .single();
      if (inserted.error?.code === "23505") {
        const { data: racedOrder, error: racedOrderError } = await supabase
          .from("shop_orders")
          .select("id")
          .eq("shopify_order_id", order.id)
          .maybeSingle();
        if (racedOrderError) throw new Error(racedOrderError.message);
        if (!racedOrder?.id) throw new Error(inserted.error.message);
        result.skipped += 1;
        result.orderIds.push(String(racedOrder.id));
        continue;
      }
      if (inserted.error || !inserted.data) throw new Error(inserted.error?.message ?? "shop_order_insert_failed");
      insertedOrderId = String(inserted.data.id);

      const itemRows = mappedItems.map(({ item, listing }) => ({
        order_id: inserted.data.id,
        listing_id: listing?.id ?? null,
        product_id: listing?.product_id ?? null,
        title: item.title,
        supplier_listing_id: listing?.supplier_listing_id ?? null,
        supplier_name: listing?.supplier_name ?? null,
        supplier_product_id: listing?.supplier_product_id ?? null,
        supplier_variant_id: listing?.supplier_variant_id ?? null,
        qty: item.quantity,
        unit_price: Number(item.originalUnitPriceSet.shopMoney.amount),
        currency: item.originalUnitPriceSet.shopMoney.currencyCode,
      }));
      const itemInsert = await supabase.from("shop_order_items").insert(itemRows);
      if (itemInsert.error) {
        await supabase.from("shop_orders").delete().eq("id", inserted.data.id).eq("shopify_order_id", order.id);
        insertedOrderId = null;
        throw new Error(`shop_order_items_insert_failed:${itemInsert.error.message}`);
      }

      insertedOrderId = null;
      await createDropshipPurchaseOrdersForShopOrder(String(inserted.data.id));
      result.imported += 1;
      result.orderIds.push(inserted.data.id);
    } catch (error) {
      if (insertedOrderId) {
        await supabase.from("shop_orders").delete().eq("id", insertedOrderId).eq("shopify_order_id", order.id);
      }
      result.failed += 1;
      result.errors.push({
        shopifyOrderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
