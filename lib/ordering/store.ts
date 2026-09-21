import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  DEFAULT_ORDERING_SETTINGS,
  parseOrderingSettings,
  type OrderingSettings,
} from "@/lib/ordering/types";
import { evaluateOrderGates, modeAllowsExecution } from "@/lib/ordering/gates";
import type { ReorderRecommendation } from "@/lib/ordering/recommend";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function getOrderingSettings(): Promise<OrderingSettings> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("ordering_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return parseOrderingSettings((data as Record<string, unknown> | null) ?? null);
}

export async function saveOrderingSettings(
  settings: OrderingSettings,
): Promise<OrderingSettings> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("ordering_settings")
    .upsert(
      {
        id: "default",
        mode: settings.mode,
        daily_order_limit: settings.dailyOrderLimit,
        per_product_order_limit: settings.perProductOrderLimit,
        monthly_order_budget: settings.monthlyOrderBudget,
        category_budgets: settings.categoryBudgets,
        default_lead_time_days: settings.defaultLeadTimeDays,
        default_safety_stock: settings.defaultSafetyStock,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return parseOrderingSettings(data as Record<string, unknown>);
}

export type ReorderListItem = {
  id: string;
  productId: string;
  opportunityId: string | null;
  onHand: number | null;
  inbound: number | null;
  forecastUnits30d: number | null;
  reorderPoint: number | null;
  recommendedQty: number | null;
  recommendedDate: string | null;
  estimatedCost: number | null;
  estimatedProfit: number | null;
  currency: string | null;
  confidence: number | null;
  orderState: string;
  rationale: string | null;
  missing: string[];
  createdAt: string;
};

function mapReorder(row: Record<string, unknown>): ReorderListItem {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    opportunityId: row.opportunity_id ? String(row.opportunity_id) : null,
    onHand: asNumber(row.on_hand),
    inbound: asNumber(row.inbound),
    forecastUnits30d: asNumber(row.forecast_units_30d),
    reorderPoint: asNumber(row.reorder_point),
    recommendedQty: asNumber(row.recommended_qty),
    recommendedDate:
      typeof row.recommended_date === "string" ? row.recommended_date : null,
    estimatedCost: asNumber(row.estimated_cost),
    estimatedProfit: asNumber(row.estimated_profit),
    currency: typeof row.currency === "string" ? row.currency : null,
    confidence: asNumber(row.confidence),
    orderState: String(row.order_state ?? "UNKNOWN_BLOCKED"),
    rationale: typeof row.rationale === "string" ? row.rationale : null,
    missing: Array.isArray(row.missing) ? row.missing.map(String) : [],
    createdAt: String(row.created_at),
  };
}

export async function listReorderRecommendations(limit = 50): Promise<ReorderListItem[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("reorder_recommendations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapReorder(row as Record<string, unknown>));
}

export async function getLatestReorderForProduct(
  productId: string,
): Promise<ReorderListItem | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("reorder_recommendations")
    .select("*")
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? mapReorder(data as Record<string, unknown>) : null;
}

export type PurchaseOrderItem = {
  id: string;
  productId: string;
  qty: number | null;
  unitCost: number | null;
  shippingCost: number | null;
  totalCost: number | null;
  currency: string | null;
  status: string;
  mode: string;
  rationale: string | null;
  forecastUnits: number | null;
  forecastProfit: number | null;
  forecastConfidence: number | null;
  approvedBy: string | null;
  supplierName: string | null;
  supplierOrderId: string | null;
  placedAt: string | null;
  createdAt: string;
};

function mapOrder(row: Record<string, unknown>): PurchaseOrderItem {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    qty: asNumber(row.qty),
    unitCost: asNumber(row.unit_cost),
    shippingCost: asNumber(row.shipping_cost),
    totalCost: asNumber(row.total_cost),
    currency: typeof row.currency === "string" ? row.currency : null,
    status: String(row.status ?? "draft"),
    mode: String(row.mode ?? "MANUAL"),
    rationale: typeof row.rationale === "string" ? row.rationale : null,
    forecastUnits: asNumber(row.forecast_units),
    forecastProfit: asNumber(row.forecast_profit),
    forecastConfidence: asNumber(row.forecast_confidence),
    approvedBy: typeof row.approved_by === "string" ? row.approved_by : null,
    supplierName: typeof row.supplier_name === "string" ? row.supplier_name : null,
    supplierOrderId:
      typeof row.supplier_order_id === "string" ? row.supplier_order_id : null,
    placedAt: typeof row.placed_at === "string" ? row.placed_at : null,
    createdAt: String(row.created_at),
  };
}

export async function listPurchaseOrders(limit = 50): Promise<PurchaseOrderItem[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("purchase_orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapOrder(row as Record<string, unknown>));
}

export async function persistReorderRecommendation(
  rec: ReorderRecommendation,
): Promise<string> {
  const supabase = createSupabaseAdminClient();

  for (const forecast of rec.inventoryForecasts) {
    const insert = await supabase.from("inventory_forecasts").insert({
      product_id: rec.productId,
      opportunity_id: rec.opportunityId,
      horizon_days: forecast.horizonDays,
      on_hand: forecast.onHand,
      inbound: forecast.inbound,
      forecast_units: forecast.forecastUnits,
      projected_on_hand: forecast.projectedOnHand,
      confidence: forecast.confidence,
      evidence: forecast.evidence,
    });
    if (insert.error) throw new Error(insert.error.message);
  }

  const { data, error } = await supabase
    .from("reorder_recommendations")
    .insert({
      product_id: rec.productId,
      opportunity_id: rec.opportunityId,
      on_hand: rec.onHand,
      inbound: rec.inbound,
      forecast_units_30d: rec.forecastUnits30d,
      average_daily_sales: rec.averageDailySales,
      lead_time_days: rec.leadTimeDays,
      safety_stock: rec.safetyStock,
      reorder_point: rec.reorderPoint,
      recommended_qty: rec.recommendedQty,
      recommended_date: rec.recommendedDate,
      estimated_cost: rec.estimatedCost,
      estimated_profit: rec.estimatedProfit,
      currency: rec.currency,
      confidence: rec.confidence,
      order_state: rec.orderState,
      rationale: rec.rationale,
      missing: rec.missing,
      evidence: rec.evidence,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return String(data.id);
}

export async function createPurchaseOrderFromRecommendation(args: {
  recommendationId: string;
  approved: boolean;
  approvedBy?: string | null;
}): Promise<PurchaseOrderItem> {
  const supabase = createSupabaseAdminClient();
  const settings = await getOrderingSettings();

  const { data: rec, error: recError } = await supabase
    .from("reorder_recommendations")
    .select("*")
    .eq("id", args.recommendationId)
    .maybeSingle();

  if (recError) throw new Error(recError.message);
  if (!rec) throw new Error("reorder recommendation not found");

  const { data: opportunity } = rec.opportunity_id
    ? await supabase
        .from("opportunity_intelligence")
        .select(
          "id, product_id, product_name, source_cost, source_currency, market_currency, profit_calculable, currency_confidence, forecast_units_30d, forecast_profit_30d, forecast_confidence, selection_eligible, metadata",
        )
        .eq("id", rec.opportunity_id)
        .maybeSingle()
    : { data: null };

  const metadata =
    opportunity?.metadata &&
    typeof opportunity.metadata === "object" &&
    !Array.isArray(opportunity.metadata)
      ? (opportunity.metadata as Record<string, unknown>)
      : {};

  const qty = asNumber(rec.recommended_qty);
  const unitCost = asNumber(opportunity?.source_cost);
  const totalCost = asNumber(rec.estimated_cost);
  const currency =
    typeof rec.currency === "string"
      ? rec.currency
      : typeof opportunity?.source_currency === "string"
        ? opportunity.source_currency
        : null;

  const gates = evaluateOrderGates(
    {
      identityConfirmed: metadata.identity_rejected !== true && metadata.identity_unconfirmed !== true,
      identityUnknown: metadata.identity_unconfirmed === true,
      supplierConfirmed: true,
      sourceCost: unitCost,
      currency,
      currencyReliable:
        opportunity?.currency_confidence === "high" ||
        opportunity?.currency_confidence === "medium",
      shippable: metadata.shippable === false ? false : metadata.shippable === true ? true : null,
      complianceRisk:
        metadata.restricted === true || metadata.hazardous === true
          ? true
          : metadata.restricted === false
            ? false
            : null,
      profitCalculable: opportunity?.profit_calculable === true,
      forecastUnits30d: asNumber(rec.forecast_units_30d),
      onHand: asNumber(rec.on_hand),
      recommendedQty: qty,
      estimatedCost: totalCost,
      supplierApiAvailable: null,
      settings,
      spentToday: 0,
      spentMonth: 0,
      spentProduct: 0,
      spentCategory: 0,
      category: typeof metadata.category === "string" ? metadata.category : null,
    },
    asNumber(rec.confidence),
  );

  if (qty === null || qty <= 0) {
    throw new Error("recommended quantity is unknown");
  }
  if (unitCost === null || !currency) {
    throw new Error("price or currency unknown");
  }
  if (
    args.approved &&
    (gates.orderState === "ORDER_FORBIDDEN" ||
      gates.orderState === "UNKNOWN_BLOCKED")
  ) {
    throw new Error(`order blocked: ${[...gates.blocked, ...gates.missing].join(", ")}`);
  }
  if (
    args.approved &&
    !modeAllowsExecution(settings.mode, args.approved, gates.canAuto)
  ) {
    throw new Error(
      settings.mode === "AUTO"
        ? "AUTO gates are not satisfied"
        : "approval is required before placing this order",
    );
  }

  const status = args.approved
    ? settings.mode === "AUTO" && !gates.canAuto
      ? "auto_blocked"
      : "placed"
    : settings.mode === "APPROVAL"
      ? "pending_approval"
      : "draft";

  const placed =
    args.approved &&
    unitCost !== null &&
    currency !== null &&
    modeAllowsExecution(settings.mode, true, gates.canAuto) &&
    gates.orderState !== "ORDER_FORBIDDEN" &&
    gates.orderState !== "UNKNOWN_BLOCKED";

  const { data, error } = await supabase
    .from("purchase_orders")
    .insert({
      product_id: rec.product_id,
      opportunity_id: rec.opportunity_id,
      recommendation_id: rec.id,
      supplier_name: "CJdropshipping",
      qty,
      unit_cost: unitCost,
      shipping_cost: null,
      total_cost: totalCost,
      currency,
      forecast_units: asNumber(rec.forecast_units_30d),
      forecast_profit: asNumber(rec.estimated_profit),
      forecast_confidence: asNumber(rec.confidence),
      rationale: rec.rationale,
      status: placed ? "placed" : status,
      mode: settings.mode,
      approved_by: args.approved ? (args.approvedBy ?? "user") : null,
      placed_at: placed ? new Date().toISOString() : null,
      metadata: {
        gates,
        note: "supplier_api_not_connected_execution_stays_recorded_only",
      },
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  const itemInsert = await supabase.from("purchase_order_items").insert({
    purchase_order_id: data.id,
    product_id: rec.product_id,
    qty,
    unit_cost: unitCost,
  });
  if (itemInsert.error) throw new Error(itemInsert.error.message);

  return mapOrder(data as Record<string, unknown>);
}

export { DEFAULT_ORDERING_SETTINGS };
