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

const REORDER_BATCH_SIZE = 10;
const REORDER_WRITE_CONCURRENCY = 3;
const RECENT_RECOMMENDATION_HOURS = 24;

/**
 * Persist a rotating, bounded set of reorder recommendations. The old patrol
 * loaded every inventory snapshot and sequentially wrote forecasts plus a
 * recommendation for up to 100 opportunities, routinely exceeding the stage
 * budget and starving the sales-test gate. Recent recommendations suppress
 * duplicate writes; inventory reads are limited to the active product IDs.
 */
export async function persistReorderRecommendations(): Promise<{
  processed: number;
  written: number;
}> {
  const supabase = createSupabaseAdminClient();
  const settings = await getOrderingSettings();

  const countResult = await supabase
    .from("opportunity_intelligence")
    .select("id", { count: "exact", head: true })
    .neq("sellability_state", "REJECTED");
  if (countResult.error) throw new Error(countResult.error.message);

  const total = countResult.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / REORDER_BATCH_SIZE));
  const page = Math.floor(Date.now() / (15 * 60_000)) % pages;
  const offset = page * REORDER_BATCH_SIZE;

  const opps = await supabase
    .from("opportunity_intelligence")
    .select(
      "id, product_id, product_name, source_cost, source_currency, market_currency, profit_calculable, currency_confidence, forecast_units_7d, forecast_units_30d, forecast_units_90d, forecast_profit_30d, forecast_confidence, selection_eligible, metadata, competitor_count",
    )
    .neq("sellability_state", "REJECTED")
    .order("id", { ascending: true })
    .range(offset, offset + REORDER_BATCH_SIZE - 1);

  if (opps.error) throw new Error(opps.error.message);
  const rows = opps.data ?? [];
  if (rows.length === 0) return { processed: 0, written: 0 };

  const opportunityIds = rows.map((row) => String(row.id));
  const productIds = [...new Set(rows.map((row) => String(row.product_id)))];
  const recentSince = new Date(Date.now() - RECENT_RECOMMENDATION_HOURS * 3_600_000).toISOString();

  const [recentResult, performanceResult, snapshotResults] = await Promise.all([
    supabase
      .from("reorder_recommendations")
      .select("opportunity_id")
      .in("opportunity_id", opportunityIds)
      .gte("created_at", recentSince),
    supabase
      .from("supplier_performance")
      .select("supplier_name, product_id, risk_note, observed_at")
      .in("product_id", productIds)
      .order("observed_at", { ascending: false })
      .limit(100),
    Promise.all(productIds.map(async (productId) => {
      const result = await supabase
        .from("inventory_snapshots")
        .select("product_id, on_hand, inbound, observed_at")
        .eq("kind", "own")
        .eq("product_id", productId)
        .order("observed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    })),
  ]);

  if (recentResult.error) throw new Error(recentResult.error.message);
  if (performanceResult.error) throw new Error(performanceResult.error.message);

  const recentlyRecommended = new Set(
    (recentResult.data ?? [])
      .map((row) => String(row.opportunity_id ?? ""))
      .filter(Boolean),
  );

  const latestOwn = new Map<string, { onHand: number | null; inbound: number | null }>();
  for (const row of snapshotResults) {
    if (!row?.product_id) continue;
    latestOwn.set(String(row.product_id), {
      onHand: asNumber(row.on_hand),
      inbound: asNumber(row.inbound),
    });
  }

  const riskByProduct = new Map<string, string>();
  for (const row of performanceResult.data ?? []) {
    if (!row.product_id || !row.risk_note) continue;
    const key = String(row.product_id);
    if (!riskByProduct.has(key)) riskByProduct.set(key, String(row.risk_note));
  }

  const pendingRows = rows.filter((row) => !recentlyRecommended.has(String(row.id)));
  let written = 0;

  for (let start = 0; start < pendingRows.length; start += REORDER_WRITE_CONCURRENCY) {
    const batch = pendingRows.slice(start, start + REORDER_WRITE_CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      const metadata = asRecord(row.metadata);
      const productId = String(row.product_id);
      const stock = latestOwn.get(productId) ?? { onHand: null, inbound: null };
      const recommendation = recommendReorder({
        productId,
        opportunityId: String(row.id),
        productName: String(row.product_name ?? "Untitled"),
        category: typeof metadata.category === "string" ? metadata.category : null,
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
        currencyReliable: row.currency_confidence === "high" || row.currency_confidence === "medium",
        identityConfirmed:
          metadata.identity_rejected !== true &&
          metadata.identity_unconfirmed !== true &&
          asNumber(metadata.identity_confidence) !== null &&
          Number(asNumber(metadata.identity_confidence)) >= 0.65,
        identityUnknown: metadata.identity_unconfirmed === true,
        supplierConfirmed:
          typeof metadata.supplier_name === "string" && metadata.supplier_name.trim().length > 0,
        supplierName:
          typeof metadata.supplier_name === "string" && metadata.supplier_name.trim()
            ? metadata.supplier_name.trim()
            : null,
        supplierApiAvailable:
          typeof metadata.supplier_api_available === "boolean"
            ? metadata.supplier_api_available
            : null,
        shippable: metadata.shippable === false ? false : metadata.shippable === true ? true : null,
        complianceRisk: metadata.restricted === true || metadata.hazardous === true ? true : null,
        profitCalculable: row.profit_calculable === true,
        leadTimeDays: settings.defaultLeadTimeDays,
        safetyStock: settings.defaultSafetyStock,
        minimumOrderQty: null,
        settings,
        // Spend aggregates are not implemented yet. Never report unknown spend as zero:
        // configured budget gates must fail closed until a real ledger-backed total exists.
        spentToday: null,
        spentMonth: null,
        spentProduct: null,
        spentCategory: null,
        supplierRiskNote: riskByProduct.get(productId) ?? null,
      });

      await persistReorderRecommendation(recommendation);
      written += 1;
    }));
  }

  return { processed: rows.length, written };
}
