import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recommendReorder } from "@/lib/ordering/recommend";
import {
  getOrderingSettings,
  persistReorderRecommendation,
} from "@/lib/ordering/store";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export async function persistReorderRecommendations(): Promise<{
  processed: number;
  written: number;
}> {
  const supabase = createSupabaseAdminClient();
  const settings = await getOrderingSettings();

  const [opps, snapshots, performance] = await Promise.all([
    supabase
      .from("opportunity_intelligence")
      .select(
        "id, product_id, product_name, source_cost, source_currency, market_currency, profit_calculable, currency_confidence, forecast_units_7d, forecast_units_30d, forecast_units_90d, forecast_profit_30d, forecast_confidence, selection_eligible, metadata, competitor_count",
      )
      .neq("sellability_state", "REJECTED")
      .limit(100),
    supabase
      .from("inventory_snapshots")
      .select("product_id, kind, on_hand, inbound, observed_at")
      .eq("kind", "own")
      .order("observed_at", { ascending: false }),
    supabase
      .from("supplier_performance")
      .select("supplier_name, product_id, risk_note, observed_at")
      .order("observed_at", { ascending: false })
      .limit(100),
  ]);

  if (opps.error) throw new Error(opps.error.message);
  if (snapshots.error) throw new Error(snapshots.error.message);
  if (performance.error) throw new Error(performance.error.message);

  const latestOwn = new Map<
    string,
    { onHand: number | null; inbound: number | null }
  >();
  for (const row of snapshots.data ?? []) {
    const productId = String(row.product_id);
    if (latestOwn.has(productId)) continue;
    latestOwn.set(productId, {
      onHand: asNumber(row.on_hand),
      inbound: asNumber(row.inbound),
    });
  }

  const riskByProduct = new Map<string, string>();
  for (const row of performance.data ?? []) {
    if (!row.product_id || !row.risk_note) continue;
    const key = String(row.product_id);
    if (!riskByProduct.has(key)) riskByProduct.set(key, String(row.risk_note));
  }

  let written = 0;
  for (const row of opps.data ?? []) {
    const metadata = asRecord(row.metadata);
    const stock = latestOwn.get(String(row.product_id)) ?? {
      onHand: null,
      inbound: null,
    };
    const recommendation = recommendReorder({
      productId: String(row.product_id),
      opportunityId: String(row.id),
      productName: String(row.product_name ?? "Untitled"),
      category:
        typeof metadata.category === "string" ? metadata.category : null,
      onHand: stock.onHand,
      inbound: stock.inbound,
      forecastUnits7d: asNumber(row.forecast_units_7d),
      forecastUnits30d: asNumber(row.forecast_units_30d),
      forecastUnits90d: asNumber(row.forecast_units_90d),
      forecastProfit30d: asNumber(row.forecast_profit_30d),
      forecastConfidence: asNumber(row.forecast_confidence),
      sourceCost: asNumber(row.source_cost),
      shippingCost: null,
      currency:
        typeof row.source_currency === "string"
          ? row.source_currency
          : typeof row.market_currency === "string"
            ? row.market_currency
            : null,
      currencyReliable:
        row.currency_confidence === "high" ||
        row.currency_confidence === "medium",
      identityConfirmed:
        metadata.identity_rejected !== true &&
        metadata.identity_unconfirmed !== true &&
        asNumber(metadata.identity_confidence) !== null &&
        Number(asNumber(metadata.identity_confidence)) >= 0.65,
      identityUnknown: metadata.identity_unconfirmed === true,
      supplierConfirmed: true,
      supplierName: "CJdropshipping",
      supplierApiAvailable: null,
      shippable:
        metadata.shippable === false
          ? false
          : metadata.shippable === true
            ? true
            : null,
      complianceRisk:
        metadata.restricted === true || metadata.hazardous === true
          ? true
          : null,
      profitCalculable: row.profit_calculable === true,
      leadTimeDays: settings.defaultLeadTimeDays,
      safetyStock: settings.defaultSafetyStock,
      minimumOrderQty: null,
      settings,
      spentToday: 0,
      spentMonth: 0,
      spentProduct: 0,
      spentCategory: 0,
      supplierRiskNote: riskByProduct.get(String(row.product_id)) ?? null,
    });

    await persistReorderRecommendation(recommendation);
    written += 1;
  }

  return { processed: opps.data?.length ?? 0, written };
}
