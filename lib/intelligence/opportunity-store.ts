import "server-only";

import type {
  ConfidenceLabel,
  OpportunityLifecycleStatus,
  SellabilityState,
} from "@/lib/domain/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { deriveFailureReasons } from "@/lib/intelligence/failure-learning";

export type OpportunityListItem = {
  id: string;
  productId: string;
  productName: string;
  imageUrl: string | null;
  demandScore: number | null;
  profitScore: number | null;
  timingScore: number | null;
  sellabilityState: SellabilityState;
  lifecycleStatus: OpportunityLifecycleStatus;
  overallConfidence: number | null;
  confidenceLabels: {
    demand: ConfidenceLabel;
    identity: ConfidenceLabel;
    supply: ConfidenceLabel;
    price: ConfidenceLabel;
    shipping: ConfidenceLabel;
    competition: ConfidenceLabel;
    creative: ConfidenceLabel;
    overall: ConfidenceLabel;
  };
  judgment: string | null;
  missing: string[];
  whyNow: Array<{
    statement: string;
    field: string;
    source: string;
    observedAt?: string | null;
    evidenceId?: string;
  }>;
  evidence: unknown[];
  estimatedContributionProfit: number | null;
  actualContributionProfit: number | null;
  competitorCount: number | null;
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
  testToOrderConversion: number | null;
  testSuccessRate: number | null;
  estimatedVsActualProfitVariance: number | null;
  timeDiscoveryToReadyHours: number | null;
  timeReadyToTestHours: number | null;
  failureReasonDistribution: Record<string, number>;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asLabel(value: unknown): ConfidenceLabel {
  if (
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function mapRow(row: Record<string, unknown>): OpportunityListItem {
  const whyNow = Array.isArray(row.why_now) ? row.why_now : [];
  const risks = Array.isArray(row.risks) ? row.risks : [];
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const explanation =
    row.generated_explanation &&
    typeof row.generated_explanation === "object" &&
    !Array.isArray(row.generated_explanation)
      ? (row.generated_explanation as Record<string, unknown>)
      : {};
  const quality =
    row.data_quality &&
    typeof row.data_quality === "object" &&
    !Array.isArray(row.data_quality)
      ? (row.data_quality as Record<string, unknown>)
      : {};

  return {
    id: String(row.id),
    productId: String(row.product_id),
    productName: String(row.product_name ?? "Untitled product"),
    imageUrl: typeof row.image_url === "string" ? row.image_url : null,
    demandScore: asNumber(row.demand_score),
    profitScore: asNumber(row.margin_score),
    timingScore: asNumber(row.timing_score),
    sellabilityState: (row.sellability_state as SellabilityState) ?? "NEEDS_DATA",
    lifecycleStatus:
      (row.lifecycle_status as OpportunityLifecycleStatus) ?? "DISCOVERED",
    overallConfidence: asNumber(row.overall_confidence),
    confidenceLabels: {
      demand: asLabel(row.demand_confidence_label),
      identity: asLabel(row.identity_confidence_label),
      supply: asLabel(row.supply_confidence_label),
      price: asLabel(row.price_confidence_label),
      shipping: asLabel(row.shipping_confidence_label),
      competition: asLabel(row.competition_confidence_label),
      creative: asLabel(row.creative_confidence_label),
      overall: asLabel(row.overall_confidence_label),
    },
    judgment:
      typeof explanation.judgment === "string" ? explanation.judgment : null,
    missing: Array.isArray(quality.missing)
      ? quality.missing.map(String)
      : Array.isArray(metadata.missing)
        ? metadata.missing.map(String)
        : [],
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
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    estimatedContributionProfit: asNumber(row.estimated_contribution_profit),
    actualContributionProfit: asNumber(row.actual_contribution_profit),
    competitorCount: asNumber(row.competitor_count),
    metadata,
  };
}

export type OpportunityDetail = OpportunityListItem & {
  calculations: unknown[];
  tests: Array<{
    id: string;
    status: string;
    channel: string | null;
    testPrice: number | null;
    hypothesis: string | null;
    experimentStage: string | null;
    startedAt: string | null;
  }>;
  failures: Array<{
    id: string;
    reasonCode: string;
    note: string | null;
    createdAt: string;
  }>;
  lifecycleEvents: Array<{
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    createdAt: string;
  }>;
};

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
      "id, product_id, product_name, image_url, demand_score, margin_score, timing_score, opportunity_score, sellability_state, lifecycle_status, overall_confidence, demand_confidence_label, identity_confidence_label, supply_confidence_label, price_confidence_label, shipping_confidence_label, competition_confidence_label, creative_confidence_label, overall_confidence_label, why_now, risks, market_price, market_currency, source_cost, source_currency, contribution_profit, contribution_margin, profit_calculable, currency_confidence, latest_test_status, metadata, ranking_priority, generated_explanation, data_quality, evidence, estimated_contribution_profit, actual_contribution_profit, competitor_count",
    )
    .order("ranking_priority", { ascending: true })
    .limit(limit);

  if (options?.state) {
    query = query.eq("sellability_state", options.state);
  } else if (!options?.includeRejected) {
    query = query
      .neq("sellability_state", "REJECTED")
      .neq("lifecycle_status", "ARCHIVED")
      .neq("lifecycle_status", "REJECTED");
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function getOpportunity(id: string): Promise<OpportunityDetail | null> {
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("opportunity_intelligence")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) return null;

  const [testsResult, failuresResult, eventsResult] = await Promise.all([
    supabase
      .from("sales_tests")
      .select(
        "id, status, channel, test_price, hypothesis, experiment_stage, started_at, start_at",
      )
      .eq("opportunity_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("opportunity_failures")
      .select("id, reason_code, note, created_at")
      .eq("opportunity_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("opportunity_lifecycle_events")
      .select("from_status, to_status, reason, created_at")
      .eq("opportunity_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (testsResult.error) throw new Error(testsResult.error.message);
  if (failuresResult.error) throw new Error(failuresResult.error.message);
  if (eventsResult.error) throw new Error(eventsResult.error.message);

  const base = mapRow(data as Record<string, unknown>);

  return {
    ...base,
    calculations: Array.isArray(data.calculations) ? data.calculations : [],
    tests: (testsResult.data ?? []).map((test) => ({
      id: String(test.id),
      status: String(test.status ?? "unknown"),
      channel: typeof test.channel === "string" ? test.channel : null,
      testPrice: asNumber(test.test_price),
      hypothesis: typeof test.hypothesis === "string" ? test.hypothesis : null,
      experimentStage:
        typeof test.experiment_stage === "string" ? test.experiment_stage : null,
      startedAt:
        typeof test.started_at === "string"
          ? test.started_at
          : typeof test.start_at === "string"
            ? test.start_at
            : null,
    })),
    failures: (failuresResult.data ?? []).map((row) => ({
      id: String(row.id),
      reasonCode: String(row.reason_code),
      note: typeof row.note === "string" ? row.note : null,
      createdAt: String(row.created_at),
    })),
    lifecycleEvents: (eventsResult.data ?? []).map((row) => ({
      fromStatus: typeof row.from_status === "string" ? row.from_status : null,
      toStatus: String(row.to_status),
      reason: typeof row.reason === "string" ? row.reason : null,
      createdAt: String(row.created_at),
    })),
  };
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number(
    (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2),
  );
}

export async function getOpportunityKpis(): Promise<OpportunityKpis> {
  const supabase = createSupabaseAdminClient();

  const [allResult, readyResult, testsResult, resultsResult, failuresResult] =
    await Promise.all([
      supabase
        .from("opportunity_intelligence")
        .select(
          "id, first_test_ready_at, first_discovered_at, estimated_contribution_profit, actual_contribution_profit",
          { count: "exact", head: false },
        )
        .neq("sellability_state", "REJECTED")
        .neq("lifecycle_status", "ARCHIVED"),
      supabase
        .from("opportunity_intelligence")
        .select("id", { count: "exact", head: true })
        .eq("sellability_state", "TEST_READY"),
      supabase
        .from("sales_tests")
        .select("id, started_at, opportunity_id, status, first_ready_at"),
      supabase
        .from("sales_test_results")
        .select(
          "test_id, orders, revenue, contribution_profit, roas, measurement_kind",
        ),
      supabase.from("opportunity_failures").select("reason_code"),
    ]);

  if (allResult.error) throw new Error(allResult.error.message);
  if (readyResult.error) throw new Error(readyResult.error.message);
  if (testsResult.error) throw new Error(testsResult.error.message);
  if (resultsResult.error) throw new Error(resultsResult.error.message);
  if (failuresResult.error) throw new Error(failuresResult.error.message);

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

  const readyToTest = (testsResult.data ?? [])
    .map((test) => {
      const opportunity = opportunityById.get(test.opportunity_id as string);
      const readyAt = opportunity?.first_test_ready_at
        ? new Date(opportunity.first_test_ready_at as string).getTime()
        : test.first_ready_at
          ? new Date(test.first_ready_at as string).getTime()
          : null;
      const startedAt = test.started_at
        ? new Date(test.started_at as string).getTime()
        : null;
      if (readyAt === null || startedAt === null) return null;
      return (startedAt - readyAt) / 3_600_000;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const discoveryToReady = (allResult.data ?? [])
    .map((row) => {
      if (!row.first_discovered_at || !row.first_test_ready_at) return null;
      return (
        (new Date(row.first_test_ready_at as string).getTime() -
          new Date(row.first_discovered_at as string).getTime()) /
        3_600_000
      );
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const testsWithOrders = new Set(
    observed
      .filter((row) => (row.orders ?? 0) > 0)
      .map((row) => row.test_id as string),
  );
  const testsWithResults = new Set(observed.map((row) => row.test_id as string));
  const testStarted = testsResult.data?.length ?? 0;
  const testToOrderConversion =
    testStarted > 0 ? Number((testsWithOrders.size / testStarted).toFixed(4)) : null;
  const testSuccessRate =
    testsWithResults.size > 0
      ? Number((winnerCandidates / testsWithResults.size).toFixed(4))
      : null;

  const profitVariance = (allResult.data ?? [])
    .map((row) => {
      const estimated = asNumber(row.estimated_contribution_profit);
      const actual = asNumber(row.actual_contribution_profit);
      if (estimated === null || actual === null) return null;
      return actual - estimated;
    })
    .filter((value): value is number => value !== null);

  const failureReasonDistribution: Record<string, number> = {};
  for (const row of failuresResult.data ?? []) {
    const code = String(row.reason_code);
    failureReasonDistribution[code] = (failureReasonDistribution[code] ?? 0) + 1;
  }

  return {
    opportunityCount: allResult.count ?? allResult.data?.length ?? 0,
    testReadyCount: readyResult.count ?? 0,
    testStarted,
    orders: observed.length > 0 ? orders : null,
    revenue: observed.length > 0 ? revenue : null,
    contributionProfit: observed.length > 0 ? contributionProfit : null,
    winnerCandidates,
    timeToTestHours: average(readyToTest),
    testToOrderConversion,
    testSuccessRate,
    estimatedVsActualProfitVariance: average(profitVariance),
    timeDiscoveryToReadyHours: average(discoveryToReady),
    timeReadyToTestHours: average(readyToTest),
    failureReasonDistribution,
  };
}

export async function startSalesTest(
  opportunityId: string,
  options?: {
    channel?: string | null;
    hypothesis?: string | null;
    testPrice?: number | null;
    budget?: number | null;
    successCriteria?: Record<string, unknown> | null;
  },
) {
  const supabase = createSupabaseAdminClient();

  const { data: opportunity, error: opportunityError } = await supabase
    .from("opportunity_intelligence")
    .select(
      "id, product_id, product_name, sellability_state, lifecycle_status, first_test_ready_at, observed_market_price, proposed_test_price",
    )
    .eq("id", opportunityId)
    .single();

  if (opportunityError || !opportunity) {
    throw new Error(opportunityError?.message ?? "Opportunity not found");
  }

  if (opportunity.sellability_state !== "TEST_READY") {
    throw new Error("Opportunity is not TEST_READY");
  }

  const now = new Date().toISOString();
  const testPrice =
    options?.testPrice ??
    asNumber(opportunity.proposed_test_price) ??
    asNumber(opportunity.observed_market_price);

  const { data: test, error: testError } = await supabase
    .from("sales_tests")
    .insert({
      opportunity_id: opportunity.id,
      product_id: opportunity.product_id,
      status: "started",
      first_ready_at: opportunity.first_test_ready_at,
      channel: options?.channel ?? null,
      test_price: testPrice,
      budget: options?.budget ?? null,
      start_at: now,
      hypothesis:
        options?.hypothesis ??
        "観測された需要と供給をもとに、観測価格または提案価格での転換を検証する",
      success_criteria: options?.successCriteria ?? {},
      experiment_stage: "hypothesis",
      inventory_risk: "unknown",
      shipping_risk: "unknown",
      return_risk: "unknown",
      compliance_risk: "unknown",
      metadata: {
        kind: "manual_start",
        product_name: opportunity.product_name,
        planned_conditions: {
          test_price: testPrice,
          budget: options?.budget ?? null,
          channel: options?.channel ?? null,
        },
      },
    })
    .select("id, status, started_at, experiment_stage")
    .single();

  if (testError) {
    throw new Error(testError.message);
  }

  await supabase
    .from("opportunity_intelligence")
    .update({
      latest_test_status: "started",
      lifecycle_status: "TESTING",
      updated_at: now,
    })
    .eq("id", opportunity.id);

  await supabase.from("opportunity_lifecycle_events").insert({
    opportunity_id: opportunity.id,
    from_status: opportunity.lifecycle_status,
    to_status: "TESTING",
    reason: "sales_test_started",
    evidence: { test_id: test.id },
  });

  return test;
}

function experimentStageFromResult(args: {
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  contributionProfit: number | null;
}): string {
  if (args.contributionProfit !== null || (args.orders !== null && args.orders > 0)) {
    return "result";
  }
  if (args.orders !== null) return "sales";
  if (args.clicks !== null && args.clicks > 0) return "conversion";
  if (args.impressions !== null && args.impressions > 0) return "traffic";
  return "creative";
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
  const addToCart = asNumber(payload.add_to_cart);
  const checkout = asNumber(payload.checkout);
  const contributionProfit = asNumber(payload.contribution_profit);
  const shippingCost = asNumber(payload.shipping_cost);
  const returns = asNumber(payload.returns);

  const provenanceKind =
    payload.provenance === "imported" ||
    payload.provenance === "manual" ||
    payload.provenance === "estimated" ||
    payload.provenance === "observed"
      ? payload.provenance
      : "observed";

  const measurementKind =
    provenanceKind === "estimated" ? "estimated" : "observed";

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
      add_to_cart: addToCart,
      checkout,
      orders,
      cvr,
      revenue,
      cogs: asNumber(payload.cogs),
      shipping_cost: shippingCost,
      fees: asNumber(payload.fees),
      ad_spend: adSpend,
      cac,
      roas,
      gross_profit: asNumber(payload.gross_profit),
      contribution_profit: contributionProfit,
      returns,
      refunds: asNumber(payload.refunds),
      repeat_rate: asNumber(payload.repeat_rate),
      measurement_kind: measurementKind,
      metadata: {
        provenance: provenanceKind,
      },
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const reasons = deriveFailureReasons({
    impressions,
    clicks,
    addToCart,
    checkout,
    orders,
    contributionProfit,
    shippingCost,
    returns,
    identityUncertain: payload.identity_uncertain === true,
    supplyUnavailable: payload.supply_unavailable === true,
  });

  if (measurementKind === "observed" && reasons.length > 0) {
    await supabase.from("opportunity_failures").insert(
      reasons.map((reason) => ({
        opportunity_id: test.opportunity_id,
        test_id: testId,
        reason_code: reason,
        metadata: { provenance: provenanceKind },
      })),
    );
  }

  const nextLifecycle = reasons.length > 0 ? "LEARNING" : "MEASURED";
  const now = new Date().toISOString();
  const actualSellingPrice = asNumber(payload.actual_selling_price);

  await supabase
    .from("sales_tests")
    .update({
      status: measurementKind === "observed" ? "measuring" : "started",
      experiment_stage: experimentStageFromResult({
        impressions,
        clicks,
        orders,
        contributionProfit,
      }),
      updated_at: now,
    })
    .eq("id", testId);

  const opportunityUpdate: Record<string, unknown> = {
    latest_test_status: measurementKind === "observed" ? "measuring" : "started",
    lifecycle_status: nextLifecycle,
    updated_at: now,
  };

  if (measurementKind === "observed") {
    if (contributionProfit !== null) {
      opportunityUpdate.actual_contribution_profit = contributionProfit;
    }
    if (actualSellingPrice !== null) {
      opportunityUpdate.actual_selling_price = actualSellingPrice;
    }
  }

  const { data: current } = await supabase
    .from("opportunity_intelligence")
    .select("lifecycle_status")
    .eq("id", test.opportunity_id)
    .maybeSingle();

  await supabase
    .from("opportunity_intelligence")
    .update(opportunityUpdate)
    .eq("id", test.opportunity_id);

  if (current?.lifecycle_status !== nextLifecycle) {
    await supabase.from("opportunity_lifecycle_events").insert({
      opportunity_id: test.opportunity_id,
      from_status: current?.lifecycle_status ?? null,
      to_status: nextLifecycle,
      reason: "sales_test_result",
      evidence: {
        test_id: testId,
        measurement_kind: measurementKind,
        failure_reasons: reasons,
      },
    });
  }

  return data;
}
