import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";

type FulfillmentOrder = {
  id: string;
  status: string;
  lineItems: {
    nodes: Array<{
      id: string;
      remainingQuantity: number;
    }>;
  };
};

type ShopOrder = {
  id: string;
  shopify_order_id: string | null;
  tracking_number: string | null;
  tracking_carrier: string | null;
  tracking_url: string | null;
  order_status: string | null;
};

export type ShopifyFulfillmentSyncResult = {
  configured: boolean;
  considered: number;
  synced: number;
  skipped: number;
  failed: number;
  errors: Array<{ orderId: string; error: string }>;
};

export async function syncShopifyFulfillments(limit = 25): Promise<ShopifyFulfillmentSyncResult> {
  if (!isShopifyConfigured()) {
    return { configured: false, considered: 0, synced: 0, skipped: 0, failed: 0, errors: [] };
  }

  const supabase = createSupabaseAdminClient();
  const { data: orders, error } = await supabase
    .from("shop_orders")
    .select("id,shopify_order_id,tracking_number,tracking_carrier,tracking_url,order_status")
    .not("shopify_order_id", "is", null)
    .not("tracking_number", "is", null)
    .in("order_status", ["shipping", "delivered", "ordered"])
    .order("shipped_at", { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const result: ShopifyFulfillmentSyncResult = {
    configured: true,
    considered: orders?.length ?? 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const order of (orders ?? []) as ShopOrder[]) {
    try {
      const data = await shopifyGraphQL<{
        order: { fulfillmentOrders: { nodes: FulfillmentOrder[] } } | null;
      }>(
        `query FulfillmentOrders($id: ID!) {
          order(id: $id) {
            fulfillmentOrders(first: 20) {
              nodes {
                id status
                lineItems(first: 100) { nodes { id remainingQuantity } }
              }
            }
          }
        }`,
        { id: order.shopify_order_id },
      );

      const eligible = (data.order?.fulfillmentOrders.nodes ?? []).filter((fo) =>
        ["OPEN", "SCHEDULED"].includes(fo.status) &&
        fo.lineItems.nodes.some((line) => line.remainingQuantity > 0),
      );
      if (!eligible.length) {
        result.skipped += 1;
        continue;
      }

      const lineItemsByFulfillmentOrder = eligible.map((fo) => ({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: fo.lineItems.nodes
          .filter((line) => line.remainingQuantity > 0)
          .map((line) => ({ id: line.id, quantity: line.remainingQuantity })),
      })).filter((item) => item.fulfillmentOrderLineItems.length > 0);

      const fulfillment = await shopifyGraphQL<{
        fulfillmentCreate: {
          fulfillment: { id: string } | null;
          userErrors: Array<{ field?: string[]; message: string }>;
        };
      }>(
        `mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
          fulfillmentCreate(fulfillment: $fulfillment) {
            fulfillment { id }
            userErrors { field message }
          }
        }`,
        {
          fulfillment: {
            lineItemsByFulfillmentOrder,
            notifyCustomer: true,
            trackingInfo: {
              number: order.tracking_number,
              company: order.tracking_carrier || undefined,
              url: order.tracking_url || undefined,
            },
          },
        },
      );

      if (fulfillment.fulfillmentCreate.userErrors.length) {
        throw new Error(fulfillment.fulfillmentCreate.userErrors.map((e) => e.message).join("; "));
      }
      if (!fulfillment.fulfillmentCreate.fulfillment) throw new Error("shopify_fulfillment_missing");

      await supabase
        .from("shop_orders")
        .update({
          order_status: "delivered" === order.order_status ? "delivered" : "shipping",
          shopify_fulfillment_status: "FULFILLED",
          shopify_synced_at: new Date().toISOString(),
        })
        .eq("id", order.id);
      result.synced += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({ orderId: order.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
