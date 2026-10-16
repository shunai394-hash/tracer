import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * The same paid customer order can be ingested by both the canonical
 * commerce pipeline (commerce_orders/procurement_orders) and the legacy one
 * (shop_orders/purchase_orders). Each pipeline only dedupes within itself, so
 * before a supplier order is approved or placed in one pipeline we check
 * whether the other already has a placed or approved supplier purchase for
 * the same customer order. Any read failure is treated as a conflict.
 */

type Db = ReturnType<typeof createSupabaseAdminClient>;

/** Every stored form of a Shopify order id (numeric and GID). */
export function shopifyOrderIdForms(value: string): string[] {
  const numeric = value.trim().replace(/^gid:\/\/shopify\/Order\//, "");
  return /^\d+$/.test(numeric) ? [numeric, `gid://shopify/Order/${numeric}`] : [value.trim()];
}

export type CrossPipelineConflict = { conflict: boolean; reason: string | null; references: string[] };

export async function legacyPurchaseConflictForCommerceOrder(
  channel: string,
  externalOrderId: string,
  db: Db = createSupabaseAdminClient(),
): Promise<CrossPipelineConflict> {
  const ext = externalOrderId.trim();
  if (!ext) return { conflict: true, reason: "commerce_order_external_id_missing", references: [] };
  const query = db.from("shop_orders").select("id");
  const { data: shopOrders, error } = channel === "shopify"
    ? await query.in("shopify_order_id", shopifyOrderIdForms(ext))
    : await query.eq("base_order_key", ext);
  if (error) return { conflict: true, reason: "legacy_order_lookup_failed:" + error.message, references: [] };
  const ids = (shopOrders ?? []).map((row) => String(row.id));
  if (ids.length === 0) return { conflict: false, reason: null, references: [] };
  const { data: purchases, error: purchaseError } = await db.from("purchase_orders")
    .select("id,supplier_order_id,human_confirmed_at").in("shop_order_id", ids);
  if (purchaseError) return { conflict: true, reason: "legacy_purchase_lookup_failed:" + purchaseError.message, references: [] };
  const active = (purchases ?? []).filter((row) => row.supplier_order_id || row.human_confirmed_at);
  return active.length > 0
    ? { conflict: true, reason: "legacy_purchase_order_already_placed_or_approved", references: active.map((row) => String(row.id)) }
    : { conflict: false, reason: null, references: [] };
}

export async function commerceProcurementConflictForShopOrder(
  shopOrderId: string,
  db: Db = createSupabaseAdminClient(),
): Promise<CrossPipelineConflict> {
  const { data: shopOrder, error } = await db.from("shop_orders")
    .select("id,base_order_key,shopify_order_id").eq("id", shopOrderId).maybeSingle();
  if (error || !shopOrder) return { conflict: true, reason: "legacy_order_lookup_failed:" + (error?.message ?? "not_found"), references: [] };
  const keys: Array<{ channel: string; ids: string[] }> = [];
  if (shopOrder.base_order_key) keys.push({ channel: "base", ids: [String(shopOrder.base_order_key)] });
  if (shopOrder.shopify_order_id) keys.push({ channel: "shopify", ids: shopifyOrderIdForms(String(shopOrder.shopify_order_id)) });
  const references: string[] = [];
  for (const key of keys) {
    const { data: orders, error: orderError } = await db.from("commerce_orders").select("id")
      .eq("channel", key.channel).in("external_order_id", key.ids);
    if (orderError) return { conflict: true, reason: "commerce_order_lookup_failed:" + orderError.message, references };
    const orderIds = (orders ?? []).map((row) => String(row.id));
    if (orderIds.length === 0) continue;
    const { data: lines, error: lineError } = await db.from("commerce_order_lines").select("id").in("order_id", orderIds);
    if (lineError) return { conflict: true, reason: "commerce_line_lookup_failed:" + lineError.message, references };
    const lineIds = (lines ?? []).map((row) => String(row.id));
    if (lineIds.length === 0) continue;
    const { data: procurement, error: procurementError } = await db.from("procurement_orders")
      .select("id,status,external_order_id").in("order_line_id", lineIds);
    if (procurementError) return { conflict: true, reason: "procurement_lookup_failed:" + procurementError.message, references };
    for (const row of procurement ?? []) {
      if (row.external_order_id || ["processing", "submitted", "confirmed", "shipped"].includes(String(row.status))) references.push(String(row.id));
    }
    const ids = (procurement ?? []).map((row) => String(row.id));
    if (ids.length > 0) {
      const { data: approvals, error: approvalError } = await db.from("commerce_events").select("entity_id")
        .eq("event_type", "procurement_approved").in("entity_id", ids);
      if (approvalError) return { conflict: true, reason: "approval_lookup_failed:" + approvalError.message, references };
      for (const row of approvals ?? []) references.push(String(row.entity_id));
    }
  }
  const unique = [...new Set(references)];
  return unique.length > 0
    ? { conflict: true, reason: "commerce_procurement_already_placed_or_approved", references: unique }
    : { conflict: false, reason: null, references: [] };
}
