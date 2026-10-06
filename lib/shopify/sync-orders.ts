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

export async function syncPaidShopifyOrders(limit = 25): Promise<ShopifyOrderSyncResult> {
  if (!isShopifyConfigured()) {
    return { configured: false, fetched: 0, imported: 0, skipped: 0, failed: 0, orderIds: [], errors: [] };
  }

  const data = await shopifyGraphQL<{
    orders: { nodes: ShopifyOrder[] };
  }>(
    `query PaidOrders($first: Int!) {
      orders(first: $first, query: "financial_status:paid", sortKey: CREATED_AT) {
        nodes {
          id name email phone displayFinancialStatus displayFulfillmentStatus createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress { name address1 address2 city province zip country countryCodeV2 phone }
          lineItems(first: 100) {
            nodes {
              id title quantity
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              variant { id sku }
            }
          }
        }
      }
    }`,
    { first: Math.min(Math.max(limit, 1), 100) },
  );

  const orders = data.orders.nodes ?? [];
  const result: ShopifyOrderSyncResult = {
    configured: true,
    fetched: orders.length,
    imported: 0,
    skipped: 0,
    failed: 0,
    orderIds: [],
    errors: [],
  };
  const supabase = createSupabaseAdminClient();

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

  const listingByVariant = new Map(
    (listings ?? []).map((row) => [String(row.shopify_variant_id), row as Record<string, unknown>]),
  );

  for (const order of orders) {
    try {
      if (order.displayFinancialStatus !== "PAID") {
        result.skipped += 1;
        continue;
      }

      const { data: existing, error: existingError } = await supabase
        .from("shop_orders")
        .select("id")
        .eq("shopify_order_id", order.id)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existing) {
        result.skipped += 1;
        result.orderIds.push(String(existing.id));
        continue;
      }

      const address = fullAddress(order.shippingAddress);
      const customerName = order.shippingAddress?.name || order.email || "Shopify customer";
      const customerEmail = order.email || "shopify-order@invalid.local";
      const phone = order.shippingAddress?.phone || order.phone || null;
      const total = Number(order.totalPriceSet.shopMoney.amount);
      if (!Number.isFinite(total)) throw new Error("shopify_total_invalid");
      if (!address) throw new Error("shopify_shipping_address_missing");

      const mappedItems = order.lineItems.nodes.map((item) => {
        const listing = item.variant?.id ? listingByVariant.get(item.variant.id) : undefined;
        return { item, listing };
      });
      const unmapped = mappedItems.filter(({ listing }) => !listing);
      if (unmapped.length) {
        throw new Error(`shopify_variant_not_mapped:${unmapped.map(({ item }) => item.variant?.sku || item.id).join(",")}`);
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
      if (inserted.error || !inserted.data) throw new Error(inserted.error?.message ?? "shop_order_insert_failed");

      const itemRows = mappedItems.map(({ item, listing }) => ({
        order_id: inserted.data.id,
        listing_id: listing?.id ?? null,
        product_id: listing?.product_id ?? null,
        title: item.title,
        qty: item.quantity,
        unit_price: Number(item.originalUnitPriceSet.shopMoney.amount),
        currency: item.originalUnitPriceSet.shopMoney.currencyCode,
      }));
      const itemInsert = await supabase.from("shop_order_items").insert(itemRows);
      if (itemInsert.error) throw new Error(itemInsert.error.message);

      result.imported += 1;
      result.orderIds.push(String(inserted.data.id));
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
