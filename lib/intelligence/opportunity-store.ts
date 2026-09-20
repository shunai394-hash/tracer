import "server-only";

import type { SellabilityState } from "@/lib/domain/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type OpportunityListItem = {
  id: string;
  productId: string;
  productName: string;
  imageUrl: string | null;
  demandScore: number | null;
  profitScore: number | null;
  timingScore: number | null;
  sellabilityState: SellabilityState;
  overallConfidence: number | null;
  whyNow: Array<{ statement: string; field: string; source: string }>;
  risks: Array<{ code: string; message: string }>;
  marketPrice: number | null;
  marketCurrency: string | null;
  sourceCost: number | null;
  sourceCurrency: string | null;
  contributionProfit: number | null;
  contributionMargin: number | null;
  profitCalculable: boolean;
  currencyConfidence: string | null;
  latestTestStatus: string | null;
  opportunityScore: number | null;
  metadata: Record<string, unknown>;
};

export type OpportunityKpis = {
  opportunityCount: number;
  testReadyCount: number;
  testStarted: number;
  orders: number | null;
  revenue: number | null;
  contributionProfit: number | null;
  winnerCandidates: number;
  timeToTestHours: number | null;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function mapRow(row: Record<string, unknown>): OpportunityListItem {
  const whyNow = Array.isArray(row.why_now) ? row.why_now : [];
  const risks = Array.isArray(row.risks) ? row.risks : [];

  return {
    id: String(row.id),
    productId: String(row.product_id),
    productName: String(row.product_name ?? "Untitled product"),
    imageUrl: typeof row.image_url === "string" ? row.image_url : null,
    demandScore: asNumber(row.demand_score),
    profitScore: asNumber(row.margin_score),
    timingScore: asNumber(row.timing_score),
    sellabilityState: (row.sellability_state as SellabilityState) ?? "NEEDS_DATA",
    overallConfidence: asNumber(row.overall_confidence),
    whyNow: whyNow as OpportunityListItem["whyNow"],
    risks: risks as OpportunityListItem["risks"],
    marketPrice: asNumber(row.market_price),
    marketCurrency:
      typeof row.market_currency === "string" ? row.market_currency : null,
    sourceCost: asNumber(row.source_cost),
    sourceCurrency:
      typeof row.source_currency === "string" ? row.source_currency : null,
    contributionProfit: asNumber(row.contribution_profit),
    contributionMargin: asNumber(row.contribution_margin),
    profitCalculable: row.profit_calculable === true,
    currencyConfidence:
      typeof row.currency_confidence === "string"
        ? row.currency_confidence
        : null,
    latestTestStatus:
      typeof row.latest_test_status === "string"
        ? row.latest_test_status
        : null,
    opportunityScore: asNumber(row.opportunity_score),
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

export async function listOpportunities(options?: {
  state?: SellabilityState;
  includeRejected?: boolean;
  limit?: number;
}): Promise<OpportunityListItem[]> {
  const supabase = createSupabaseAdminClient();
  const limit = options?.limit ?? 100;

  let query = supabase
    .from("opportunity_intelligence")
    .select(
      "id, product_id, product_name, image_url, demand_score, margin_score, timing_score, opportunity_score, sellability_state, overall_confidence, why_now, risks, market_price, market_currency, source_cost, source_currency, contribution_profit, contribution_margin, profit_calculable, currency_confidence, latest_test_status, metadata, ranking_priority",
    )
    .order("ranking_priority", { ascending: true })
    .limit(limit);

  if (options?.state) {
    query = query.eq("sellability_state", options.state);
  } else if (!options?.includeRejected) {
    query = query.neq("sellability_state", "REJECTED");
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function getOpportunity(id: string): Promise<OpportunityListItem | null> {
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("opportunity_intelligence")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function getOpportunityKpis(): Promise<OpportunityKpis> {
  const supabase = createSupabaseAdminClient();

  const [allResult, readyResult, testsResult, resultsResult] = await Promise.all([
    supabase
      .from("opportunity_intelligence")
      .select("id, first_test_ready_at", { count: "exact", head: false })
      .neq("sellability_state", "REJECTED"),
    supabase
      .from("opportunity_intelligence")
      .select("id", { count: "exact", head: true })
      .eq("sellability_state", "TEST_READY"),
    supabase
      .from("sales_tests")
      .select("id, started_at, opportunity_id, status"),
    supabase
      .from("sales_test_results")
      .select("orders, revenue, contribution_profit, roas, measurement_kind"),
  ]);

  if (allResult.error) throw new Error(allResult.error.message);
  if (readyResult.error) throw new Error(readyResult.error.message);
  if (testsResult.error) throw new Error(testsResult.error.message);
  if (resultsResult.error) throw new Error(resultsResult.error.message);

  const observed = (resultsResult.data ?? []).filter(
    (row) => row.measurement_kind === "observed",
  );

  const orders = observed.reduce((sum, row) => sum + (row.orders ?? 0), 0);
  const revenue = observed.reduce(
    (sum, row) => sum + (asNumber(row.revenue) ?? 0),
    0,
  );
  const contributionProfit = observed.reduce(
    (sum, row) => sum + (asNumber(row.contribution_profit) ?? 0),
    0,
  );
  const winnerCandidates = observed.filter((row) => {
    const roas = asNumber(row.roas);
    const profit = asNumber(row.contribution_profit);
    return (roas !== null && roas > 1) || (profit !== null && profit > 0);
  }).length;

  const opportunityById = new Map(
    (allResult.data ?? []).map((row) => [row.id as string, row]),
  );

  const durations = (testsResult.data ?? [])
    .map((test) => {
      const opportunity = opportunityById.get(test.opportunity_id as string);
      const readyAt = opportunity?.first_test_ready_at
        ? new Date(opportunity.first_test_ready_at as string).getTime()
        : null;
      const startedAt = test.started_at
        ? new Date(test.started_at as string).getTime()
        : null;
      if (readyAt === null || startedAt === null) return null;
      return (startedAt - readyAt) / 3_600_000;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  return {
    opportunityCount: allResult.count ?? allResult.data?.length ?? 0,
    testReadyCount: readyResult.count ?? 0,
    testStarted: testsResult.data?.length ?? 0,
    orders: observed.length > 0 ? orders : null,
    revenue: observed.length > 0 ? revenue : null,
    contributionProfit: observed.length > 0 ? contributionProfit : null,
    winnerCandidates,
    timeToTestHours:
      durations.length > 0
        ? Number(
            (
              durations.reduce((sum, value) => sum + value, 0) / durations.length
            ).toFixed(2),
          )
        : null,
  };
}

export async function startSalesTest(opportunityId: string) {
  const supabase = createSupabaseAdminClient();

  const { data: opportunity, error: opportunityError } = await supabase
    .from("opportunity_intelligence")
    .select("id, product_id, sellability_state, first_test_ready_at")
    .eq("id", opportunityId)
    .single();

  if (opportunityError || !opportunity) {
    throw new Error(opportunityError?.message ?? "Opportunity not found");
  }

  if (opportunity.sellability_state !== "TEST_READY") {
    throw new Error("Opportunity is not TEST_READY");
  }

  const { data: test, error: testError } = await supabase
    .from("sales_tests")
    .insert({
      opportunity_id: opportunity.id,
      product_id: opportunity.product_id,
      status: "started",
      first_ready_at: opportunity.first_test_ready_at,
      metadata: {
        kind: "manual_start",
      },
    })
    .select("id, status, started_at")
    .single();

  if (testError) {
    throw new Error(testError.message);
  }

  await supabase
    .from("opportunity_intelligence")
    .update({
      latest_test_status: "started",
      updated_at: new Date().toISOString(),
    })
    .eq("id", opportunity.id);

  return test;
}

export async function recordSalesTestResult(
  testId: string,
  payload: Record<string, unknown>,
) {
  const supabase = createSupabaseAdminClient();

  const { data: test, error: testError } = await supabase
    .from("sales_tests")
    .select("id, opportunity_id")
    .eq("id", testId)
    .single();

  if (testError || !test) {
    throw new Error(testError?.message ?? "Sales test not found");
  }

  const impressions = asNumber(payload.impressions);
  const clicks = asNumber(payload.clicks);
  const orders = asNumber(payload.orders);
  const revenue = asNumber(payload.revenue);
  const adSpend = asNumber(payload.ad_spend);

  const ctr =
    impressions && impressions > 0 && clicks !== null
      ? clicks / impressions
      : asNumber(payload.ctr);
  const cvr =
    clicks && clicks > 0 && orders !== null
      ? orders / clicks
      : asNumber(payload.cvr);
  const cac =
    orders && orders > 0 && adSpend !== null
      ? adSpend / orders
      : asNumber(payload.cac);
  const roas =
    adSpend && adSpend > 0 && revenue !== null
      ? revenue / adSpend
      : asNumber(payload.roas);

  const { data, error } = await supabase
    .from("sales_test_results")
    .insert({
      test_id: testId,
      creative_variant_id:
        typeof payload.creative_variant_id === "string"
          ? payload.creative_variant_id
          : null,
      impressions,
      clicks,
      ctr,
      add_to_cart: asNumber(payload.add_to_cart),
      checkout: asNumber(payload.checkout),
      orders,
      cvr,
      revenue,
      cogs: asNumber(payload.cogs),
      shipping_cost: asNumber(payload.shipping_cost),
      fees: asNumber(payload.fees),
      ad_spend: adSpend,
      cac,
      roas,
      gross_profit: asNumber(payload.gross_profit),
      contribution_profit: asNumber(payload.contribution_profit),
      returns: asNumber(payload.returns),
      refunds: asNumber(payload.refunds),
      repeat_rate: asNumber(payload.repeat_rate),
      measurement_kind: "observed",
      metadata: {
        provenance: "observed",
      },
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  await supabase
    .from("sales_tests")
    .update({
      status: "measuring",
      updated_at: new Date().toISOString(),
    })
    .eq("id", testId);

  await supabase
    .from("opportunity_intelligence")
    .update({
      latest_test_status: "measuring",
      updated_at: new Date().toISOString(),
    })
    .eq("id", test.opportunity_id);

  return data;
}
