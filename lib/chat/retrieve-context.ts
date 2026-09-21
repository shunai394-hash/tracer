import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { classifyChatIntent, type ChatIntent } from "@/lib/chat/intent";

export type ChatLink = {
  label: string;
  href: string;
};

export type ChatFacts = {
  intent: ChatIntent;
  generatedAt: string;
  opportunities: Array<Record<string, unknown>>;
  selected: Record<string, unknown> | null;
  demand: Array<Record<string, unknown>>;
  selectedDemand: Record<string, unknown> | null;
  funnel: Record<string, unknown> | null;
  missing: string[];
};

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

function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function pickOpportunity(
  message: string,
  rows: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  const normalized = message.normalize("NFKC").toLowerCase();
  const named = rows.find((row) => {
    const name = String(row.product_name ?? "").toLowerCase();
    return name.length >= 4 && normalized.includes(name);
  });
  return named ?? rows[0] ?? null;
}

function pickDemand(
  message: string,
  rows: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  const normalized = message.normalize("NFKC").toLowerCase();
  const named = rows.find((row) => {
    const query = String(row.query ?? "").toLowerCase();
    return query.length >= 2 && normalized.includes(query);
  });
  return named ?? rows[0] ?? null;
}

export async function retrieveChatFacts(message: string): Promise<ChatFacts> {
  const intent = classifyChatIntent(message);
  const supabase = createSupabaseAdminClient();
  const missing: string[] = [];

  const opportunitiesQuery = supabase
    .from("opportunity_intelligence")
    .select(
      "id, product_id, product_name, sellability_state, lifecycle_status, demand_score, demand_volume, demand_velocity_7d, demand_trend, demand_stability, market_gap_score, search_fit_score, selection_score, selection_eligible, competitor_count, market_price, market_currency, source_cost, source_currency, contribution_profit, contribution_margin, profit_calculable, forecast_units_7d, forecast_units_30d, forecast_revenue_30d, forecast_profit_30d, forecast_confidence, forecast_kind, forecast_error_units_30d, recommendation_summary, recommendation_reasons, identity_confidence_label, overall_confidence, data_quality, metadata, ranking_priority",
    )
    .neq("sellability_state", "REJECTED")
    .order("ranking_priority", { ascending: true })
    .limit(8);

  const demandQuery = supabase
    .from("demand_intelligence")
    .select(
      "id, query, volume, velocity_7d, velocity_14d, velocity_30d, trend, stability, spike, demand_score, demand_confidence, social_mentions, observation_count, last_observed_at, series",
    )
    .order("last_observed_at", { ascending: false })
    .limit(8);

  const [firstOpportunities, demandResult] = await Promise.all([
    opportunitiesQuery,
    demandQuery,
  ]);

  const opportunitiesResult = firstOpportunities.error
    ? await supabase
        .from("opportunity_intelligence")
        .select(
          "id, product_id, product_name, sellability_state, lifecycle_status, demand_score, market_gap_score, search_fit_score, selection_score, selection_eligible, competitor_count, market_price, market_currency, source_cost, source_currency, contribution_profit, contribution_margin, profit_calculable, forecast_units_7d, forecast_units_30d, forecast_revenue_30d, forecast_profit_30d, forecast_confidence, forecast_kind, forecast_error_units_30d, recommendation_summary, recommendation_reasons, identity_confidence_label, overall_confidence, data_quality, metadata, ranking_priority",
        )
        .neq("sellability_state", "REJECTED")
        .order("ranking_priority", { ascending: true })
        .limit(8)
    : firstOpportunities;

  const opportunityRows = (opportunitiesResult.data ?? []) as Array<
    Record<string, unknown>
  >;

  if (opportunitiesResult.error) {
    missing.push(`opportunities:${opportunitiesResult.error.message}`);
  }
  if (demandResult.error) {
    missing.push(`demand_intelligence:${demandResult.error.message}`);
  }

  const opportunities = opportunityRows.map((row) => {
    const quality = asRecord(row.data_quality);
    return {
      id: row.id,
      product_id: row.product_id,
      product_name: row.product_name,
      sellability_state: row.sellability_state,
      lifecycle_status: row.lifecycle_status,
      demand_score: asNumber(row.demand_score),
      demand_volume: asNumber(row.demand_volume),
      demand_velocity_7d: asNumber(row.demand_velocity_7d),
      demand_trend: row.demand_trend ?? null,
      demand_stability: row.demand_stability ?? null,
      market_gap_score: asNumber(row.market_gap_score),
      search_fit_score: asNumber(row.search_fit_score),
      selection_score: asNumber(row.selection_score),
      selection_eligible: row.selection_eligible ?? null,
      competitor_count: asNumber(row.competitor_count),
      market_price: asNumber(row.market_price),
      market_currency: row.market_currency ?? null,
      source_cost: asNumber(row.source_cost),
      contribution_profit: asNumber(row.contribution_profit),
      contribution_margin: asNumber(row.contribution_margin),
      profit_calculable: row.profit_calculable === true,
      forecast_units_7d: asNumber(row.forecast_units_7d),
      forecast_units_30d: asNumber(row.forecast_units_30d),
      forecast_revenue_30d: asNumber(row.forecast_revenue_30d),
      forecast_profit_30d: asNumber(row.forecast_profit_30d),
      forecast_confidence: asNumber(row.forecast_confidence),
      forecast_kind: row.forecast_kind ?? null,
      forecast_error_units_30d: asNumber(row.forecast_error_units_30d),
      recommendation_summary: row.recommendation_summary ?? null,
      recommendation_reasons: row.recommendation_reasons ?? [],
      identity_confidence: row.identity_confidence_label ?? null,
      overall_confidence: asNumber(row.overall_confidence),
      missing: Array.isArray(quality.missing) ? quality.missing : [],
      demand_query: asRecord(row.metadata).demand_query ?? null,
    };
  });

  const demand = (demandResult.data ?? []).map((row) => ({
    id: row.id,
    query: row.query,
    volume: asNumber(row.volume),
    velocity_7d: asNumber(row.velocity_7d),
    velocity_14d: asNumber(row.velocity_14d),
    velocity_30d: asNumber(row.velocity_30d),
    trend: row.trend ?? "unknown",
    stability: row.stability ?? "unknown",
    spike: row.spike === true,
    demand_score: asNumber(row.demand_score),
    demand_confidence: asNumber(row.demand_confidence),
    social_mentions: asNumber(row.social_mentions),
    observation_count: asNumber(row.observation_count),
    last_observed_at: row.last_observed_at ?? null,
    series: row.series ?? [],
  }));

  const selected = pickOpportunity(message, opportunities);
  const selectedDemand = pickDemand(message, demand);

  let funnel: Record<string, unknown> | null = null;
  if (selected?.id) {
    const testsResult = await supabase
      .from("sales_tests")
      .select("id, status, started_at")
      .eq("opportunity_id", selected.id)
      .order("created_at", { ascending: false })
      .limit(1);

    const test = testsResult.data?.[0] ?? null;
    if (!test) {
      funnel = null;
    } else {
      const results = await supabase
        .from("sales_test_results")
        .select(
          "impressions, clicks, ctr, product_views, add_to_cart, checkout, orders, cvr, revenue, contribution_profit, measurement_kind, measured_at",
        )
        .eq("test_id", test.id)
        .eq("measurement_kind", "observed")
        .order("measured_at", { ascending: false })
        .limit(1);

      const row = results.data?.[0] ?? null;
      if (!row) {
        funnel = {
          test_id: test.id,
          test_status: test.status,
          observed: false,
        };
      } else {
        const impressions = asNumber(row.impressions);
        const clicks = asNumber(row.clicks);
        const views = asNumber(row.product_views);
        const cart = asNumber(row.add_to_cart);
        const checkout = asNumber(row.checkout);
        const orders = asNumber(row.orders);
        funnel = {
          test_id: test.id,
          test_status: test.status,
          observed: true,
          measured_at: row.measured_at ?? null,
          impressions,
          clicks,
          ctr: asNumber(row.ctr) ?? rate(clicks, impressions),
          product_views: views,
          add_to_cart: cart,
          atc_rate: rate(cart, clicks ?? views ?? impressions),
          checkout,
          purchases: orders,
          conversion_rate: asNumber(row.cvr) ?? rate(orders, clicks),
          revenue: asNumber(row.revenue),
          profit: asNumber(row.contribution_profit),
        };
      }
    }
  }

  if (opportunities.length === 0) missing.push("no_opportunities");
  if (demand.length === 0) missing.push("no_demand_intelligence");
  if (selected && selected.market_price === null) missing.push("domestic_price");
  if (selected && selected.profit_calculable !== true) missing.push("profit");
  if (selected && selected.forecast_units_30d === null) missing.push("forecast");
  if (!funnel || funnel.observed !== true) missing.push("sales_results");

  return {
    intent,
    generatedAt: new Date().toISOString(),
    opportunities,
    selected,
    demand,
    selectedDemand,
    funnel,
    missing,
  };
}

export function linksForFacts(facts: ChatFacts): ChatLink[] {
  const links: ChatLink[] = [];
  if (facts.selected?.id) {
    links.push({
      label: "商品を見る",
      href: `/intelligence/${facts.selected.id}`,
    });
    links.push({
      label: "販売予測",
      href: `/intelligence/${facts.selected.id}#forecast`,
    });
    links.push({
      label: "販売テスト",
      href: `/intelligence/${facts.selected.id}#test`,
    });
    links.push({
      label: "カート分析",
      href: `/intelligence/${facts.selected.id}#funnel`,
    });
  }
  if (facts.selectedDemand?.id) {
    links.push({
      label: "市場分析",
      href: `/demand/${facts.selectedDemand.id}`,
    });
  } else {
    links.push({ label: "市場分析", href: "/demand" });
  }
  links.push({ label: "商機一覧", href: "/intelligence" });
  return links;
}
