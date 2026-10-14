import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";

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
  let selectedNewOrders = 0;
  let after: string | null = null;
  let hasNextOrdersPage = true;

  // Search newest paid orders first. Include existing parents for line-item
  // reconciliation, while the cap applies only to genuinely new parent orders.
  // The scan is bounded to avoid unbounded webhook work if old rows dominate.
  while (hasNextOrdersPage && selectedNewOrders < maxNewOrders && scannedOrders < 500) {
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
        .in("shopify_order_id", pageOrders.map((order) => order.id));
      if (existingRowsError) throw new Error(existingRowsError.message);
      const existingIds = new Set((existingRows ?? []).map((row) => String(row.shopify_order_id)));
      for (const order of pageOrders) {
        const isNewOrder = !existingIds.has(order.id);
        // Enforce the requested cap inside the page loop too; otherwise one
        // 100-order page can exceed a small maxNewOrders value such as 25.
        if (isNewOrder && selectedNewOrders >= maxNewOrders) break;
        if (orders.length >= 500) break;
        orders.push(order);
        if (isNewOrder) selectedNewOrders += 1;
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
        .select("id,product_id,title,shopify_product_id,shopify_variant_id,supplier_variant_id,supplier_product_id")
        .in("shopify_variant_id", variantIds)
    : { data: [], error: null };
  if (listingError) throw new Error(listingError.message);

  const listingByVariant = new Map<string, Record<string, unknown>>();
  for (const row of listings ?? []) {
    const variantId = String(row.shopify_variant_id ?? "").trim();
    if (!variantId) continue;
    const existing = listingByVariant.get(variantId);
    if (existing && String(existing.id) !== String(row.id)) {
      // A Shopify variant must resolve to exactly one internal listing. Picking
      // the last duplicate silently attaches a paid order to the wrong product.
      throw new Error(`shopify_variant_mapping_ambiguous:${variantId}`);
    }
    listingByVariant.set(variantId, row as Record<string, unknown>);
  }

  for (const order of orders) {
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
        .eq("shopify_order_id", order.id)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);

      // Existing parents are not automatically considered complete. Reconcile
      // line items by Shopify's immutable line-item ID so a prior partial insert
      // can be repaired without creating a second parent order.
      const address = fullAddress(order.shippingAddress);
      const customerName = order.shippingAddress?.name || order.email || "Shopify customer";
      const customerEmail = order.email || "shopify-order@invalid.local";
      const phone = order.shippingAddress?.phone || order.phone || null;
      const total = finitePositiveNumber(order.totalPriceSet.shopMoney.amount);
      if (total === null) throw new Error("shopify_total_invalid");
      if (!address) throw new Error("shopify_shipping_address_missing");
      if (!order.lineItems.nodes.length) throw new Error("shopify_line_items_missing");

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
      let targetOrderId: string;
      if (existing?.id) {
        targetOrderId = String(existing.id);
      } else {
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
          // Another worker may have inserted the parent. Read it and reconcile
          // its lines below instead of acknowledging a potentially partial row.
          const { data: racedOrder, error: racedOrderError } = await supabase
            .from("shop_orders")
            .select("id")
            .eq("shopify_order_id", order.id)
            .maybeSingle();
          if (racedOrderError || !racedOrder?.id) {
            throw new Error(racedOrderError?.message ?? "shopify_order_conflict_unresolved");
          }
          targetOrderId = String(racedOrder.id);
        } else {
          if (inserted.error || !inserted.data) throw new Error(inserted.error?.message ?? "shop_order_insert_failed");
          targetOrderId = String(inserted.data.id);
        }
      }

      const { data: priorLines, error: priorLinesError } = await supabase
        .from("shop_order_items")
        .select("shopify_line_item_id, listing_id, qty, unit_price")
        .eq("order_id", targetOrderId);
      if (priorLinesError) throw new Error(priorLinesError.message);
      const priorById = new Map<string, Record<string, unknown>>();
      for (const line of priorLines ?? []) {
        const lineId = line.shopify_line_item_id == null ? "" : String(line.shopify_line_item_id);
        if (!lineId) {
          // Legacy rows without Shopify IDs cannot be safely associated by
          // title/SKU alone. Fail closed rather than create duplicate purchases.
          throw new Error(`shopify_existing_line_missing_external_id:${targetOrderId}`);
        }
        if (priorById.has(lineId)) throw new Error(`shopify_existing_line_duplicate_external_id:${lineId}`);
        priorById.set(lineId, line as Record<string, unknown>);
      }

      const missingRows: Array<Record<string, unknown>> = [];
      for (const { item, listing } of mappedItems) {
        const lineId = item.id;
        const qty = item.quantity;
        const unitPrice = Number(item.originalUnitPriceSet.shopMoney.amount);
        const prior = priorById.get(lineId);
        if (prior) {
          if (String(prior.listing_id) !== String(listing?.id) ||
              Number(prior.qty) !== qty ||
              Number(prior.unit_price) !== unitPrice) {
            throw new Error(`shopify_existing_line_replay_conflict:${lineId}`);
          }
          continue;
        }
        missingRows.push({
          order_id: targetOrderId,
          shopify_line_item_id: lineId,
          listing_id: listing?.id ?? null,
          product_id: listing?.product_id ?? null,
          title: item.title,
          qty,
          unit_price: unitPrice,
          currency: item.originalUnitPriceSet.shopMoney.currencyCode,
        });
      }

      if (missingRows.length) {
        const itemInsert = await supabase
          .from("shop_order_items")
          .upsert(missingRows, { onConflict: "order_id,shopify_line_item_id", ignoreDuplicates: true });
        if (itemInsert.error) throw new Error(`shop_order_items_reconcile_failed:${itemInsert.error.message}`);

        // Verify every expected external line ID after a concurrent insert race.
        const { data: confirmedLines, error: confirmedError } = await supabase
          .from("shop_order_items")
          .select("shopify_line_item_id, listing_id, qty, unit_price")
          .eq("order_id", targetOrderId)
          .in("shopify_line_item_id", missingRows.map((row) => String(row.shopify_line_item_id)));
        if (confirmedError) throw new Error(confirmedError.message);
        const confirmedById = new Map((confirmedLines ?? []).map((line) => [String(line.shopify_line_item_id), line]));
        for (const expected of missingRows) {
          const confirmed = confirmedById.get(String(expected.shopify_line_item_id));
          if (!confirmed ||
              String(confirmed.listing_id) !== String(expected.listing_id) ||
              Number(confirmed.qty) !== Number(expected.qty) ||
              Number(confirmed.unit_price) !== Number(expected.unit_price)) {
            throw new Error(`shopify_line_item_reconcile_conflict:${String(expected.shopify_line_item_id)}`);
          }
        }
      }

      if (existing?.id) result.skipped += 1;
      else result.imported += 1;
      result.orderIds.push(targetOrderId);
    } catch (error) {
      // Keep the parent and any successfully persisted line items. A later
      // replay can reconcile missing IDs; deleting here would hide failures
      // and the previous cleanup path ignored delete errors.
      result.failed += 1;
      result.errors.push({
        shopifyOrderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
