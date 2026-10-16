import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getShopifyGrantedScopes, isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";
import { persistOrderStateUpdate } from "@/lib/ordering/status-write";

type FulfillmentOrder = {
  id: string;
  status: string;
  lineItems: {
    nodes: Array<{
      id: string;
      remainingQuantity: number;
      lineItem?: { id: string } | null;
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
  blockers?: string[];
};

export async function syncShopifyFulfillments(limit = 25): Promise<ShopifyFulfillmentSyncResult> {
  if (!isShopifyConfigured()) {
    return { configured: false, considered: 0, synced: 0, skipped: 0, failed: 0, errors: [] };
  }

  const requiredScopes = ["read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"];
  const grantedScopes = await getShopifyGrantedScopes();
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
  if (missingScopes.length > 0) {
    return {
      configured: true,
      considered: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      blockers: [`shopify_required_scopes_missing:${missingScopes.join(",")}`],
    };
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
        order: {
          fulfillmentOrders: { nodes: FulfillmentOrder[] };
          fulfillments: { nodes: Array<{ id: string; status: string; trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }> }> };
        } | null;
      }>(
        `query FulfillmentOrders($id: ID!) {
          order(id: $id) {
            fulfillmentOrders(first: 20) {
              nodes {
                id status
                lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } }
              }
            }
            fulfillments(first: 20) {
              nodes { id status trackingInfo { number url company } }
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

      const stateWrite = await persistOrderStateUpdate(
        { table: "shop_orders", id: order.id, context: "shopify_fulfillment_sync_state" },
        () => supabase
          .from("shop_orders")
          .update({
            order_status: "delivered" === order.order_status ? "delivered" : "shipping",
            shopify_fulfillment_status: "FULFILLED",
            shopify_synced_at: new Date().toISOString(),
          })
          .eq("id", order.id),
      );
      if (!stateWrite.ok) {
        throw new Error(`shopify_fulfillment_state_persist_failed_manual_reconciliation_required:${stateWrite.error}`);
      }
      result.synced += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({ orderId: order.id, error: error instanceof Error ? error.message : String(error) });
    }
  }


  // Canonical commerce orders use commerce_orders/commerce_order_lines, not the legacy shop_orders table.
  // Publish supplier tracking to Shopify only for exact lines whose procurement orders have shipped.
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];
  const { data: commerceOrders, error: commerceOrderError } = await supabase
    .from("commerce_orders")
    .select("id,external_order_id,raw_payload,commerce_order_lines(id,external_line_id,quantity,procurement_orders(id,status,tracking_number,tracking_url,shipped_at))")
    .eq("channel", "shopify")
    .eq("payment_status", "paid")
    .eq("fulfillment_status", "shipped")
    .not("external_order_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (commerceOrderError) {
    result.failed += 1;
    result.errors.push({ orderId: "commerce_orders", error: commerceOrderError.message });
  } else {
    result.considered += commerceOrders?.length ?? 0;
    for (const orderValue of commerceOrders ?? []) {
      const order = asRecord(orderValue);
      const orderId = String(order.id ?? "");
      try {
        const rawPayload = asRecord(order.raw_payload);
        let syncedGroups = asArray(rawPayload.tracerShopifyFulfillmentGroups).map(asRecord);
        const lines = asArray(order.commerce_order_lines).map(asRecord);
        const groups = new Map<string, { trackingNumber: string; trackingUrl: string | null; lines: Array<{ externalLineId: string; quantity: number }> }>();
        for (const line of lines) {
          const externalLineId = String(line.external_line_id ?? "");
          const quantity = Math.max(0, Number(line.quantity) || 0);
          if (!externalLineId || quantity <= 0) continue;
          for (const procurementValue of asArray(line.procurement_orders)) {
            const procurement = asRecord(procurementValue);
            const trackingNumber = String(procurement.tracking_number ?? "").trim();
            const trackingUrl = typeof procurement.tracking_url === "string" && procurement.tracking_url.trim() ? procurement.tracking_url.trim() : null;
            if (procurement.status !== "shipped" || !trackingNumber) continue;
            const key = trackingNumber + "|" + (trackingUrl ?? "");
            const group = groups.get(key) ?? { trackingNumber, trackingUrl, lines: [] };
            group.lines.push({ externalLineId, quantity });
            groups.set(key, group);
          }
        }
        if (!groups.size) {
          result.skipped += 1;
          continue;
        }
        const rawOrderId = String(order.external_order_id ?? "").trim();
        const orderGid = rawOrderId.startsWith("gid://shopify/Order/")
          ? rawOrderId
          : /^[0-9]+$/.test(rawOrderId) ? "gid://shopify/Order/" + rawOrderId : "";
        if (!orderGid) throw new Error("shopify_order_id_invalid");

        let orderSynced = false;
        for (const [key, group] of groups) {
          if (syncedGroups.some((item) => item.key === key && typeof item.syncedAt === "string")) continue;
          const data = await shopifyGraphQL<{
            order: {
              fulfillmentOrders: { nodes: FulfillmentOrder[] };
              fulfillments: { nodes: Array<{ id: string; status: string; trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }> }> };
            } | null;
          }>(
            `query CommerceFulfillmentOrders($id: ID!) {
              order(id: $id) {
                fulfillmentOrders(first: 20) {
                  nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } } }
                }
                fulfillments(first: 20) { nodes { id status trackingInfo { number url company } } }
              }
            }`,
            { id: orderGid },
          );
          if (!data.order) throw new Error("shopify_order_not_found");
          const existing = data.order.fulfillments.nodes.find((fulfillment) =>
            fulfillment.trackingInfo.some((tracking) => tracking.number === group.trackingNumber),
          );
          let fulfillmentId: string | null = existing?.id ?? null;
          if (!fulfillmentId) {
            const wanted = new Map(group.lines.map((line) => [
              line.externalLineId.startsWith("gid://shopify/LineItem/")
                ? line.externalLineId
                : "gid://shopify/LineItem/" + line.externalLineId,
              line.quantity,
            ]));
            const lineItemsByFulfillmentOrder = data.order.fulfillmentOrders.nodes
              .filter((fulfillmentOrder) => ["OPEN", "SCHEDULED"].includes(fulfillmentOrder.status))
              .map((fulfillmentOrder) => ({
                fulfillmentOrderId: fulfillmentOrder.id,
                fulfillmentOrderLineItems: fulfillmentOrder.lineItems.nodes
                  .filter((line) => line.remainingQuantity > 0 && Boolean(line.lineItem?.id && wanted.has(line.lineItem.id)))
                  .map((line) => ({
                    id: line.id,
                    quantity: Math.min(line.remainingQuantity, wanted.get(line.lineItem?.id ?? "") ?? 0),
                  }))
                  .filter((line) => line.quantity > 0),
              }))
              .filter((item) => item.fulfillmentOrderLineItems.length > 0);
            if (!lineItemsByFulfillmentOrder.length) {
              result.failed += 1;
              result.errors.push({ orderId, error: "shopify_fulfillment_line_match_missing:" + group.trackingNumber });
              continue;
            }
            const fulfillment = await shopifyGraphQL<{
              fulfillmentCreate: {
                fulfillment: { id: string } | null;
                userErrors: Array<{ field?: string[]; message: string }>;
              };
            }>(
              `mutation CommerceFulfillmentCreate($fulfillment: FulfillmentInput!) {
                fulfillmentCreate(fulfillment: $fulfillment) {
                  fulfillment { id }
                  userErrors { field message }
                }
              }`,
              {
                fulfillment: {
                  lineItemsByFulfillmentOrder,
                  notifyCustomer: true,
                  trackingInfo: { number: group.trackingNumber, url: group.trackingUrl ?? undefined },
                },
              },
            );
            if (fulfillment.fulfillmentCreate.userErrors.length) {
              throw new Error(fulfillment.fulfillmentCreate.userErrors.map((error) => error.message).join("; "));
            }
            fulfillmentId = fulfillment.fulfillmentCreate.fulfillment?.id ?? null;
            if (!fulfillmentId) throw new Error("shopify_fulfillment_missing");
          }
          const syncedAt = new Date().toISOString();
          const marker = { key, trackingNumber: group.trackingNumber, trackingUrl: group.trackingUrl, fulfillmentId, syncedAt };
          const nextGroups = [...syncedGroups.filter((item) => item.key !== key), marker];
          const { error: stateError } = await supabase.from("commerce_orders").update({
            raw_payload: { ...rawPayload, tracerShopifyFulfillmentGroups: nextGroups },
            updated_at: syncedAt,
          }).eq("id", orderId);
          if (stateError) throw new Error("commerce_fulfillment_state_persist_failed:" + stateError.message);
          syncedGroups = nextGroups;
          result.synced += 1;
          orderSynced = true;
        }
        if (!orderSynced) result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({ orderId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return result;
}
