import "server-only";

import type {
  CurrencyConfidence,
  ProvenanceEntry,
  SellabilityState,
} from "@/lib/domain/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  assessCurrencyConfidence,
  verifyCurrencyConfidenceInvariants,
} from "@/lib/intelligence/currency-confidence";
import {
  assessDemandRelevance,
  verifyIdentityInvariants,
} from "@/lib/intelligence/identity-confidence";
import {
  simulateContributionProfit,
  verifyProfitInvariants,
} from "@/lib/intelligence/simulate-profit";
import {
  asProvenance,
  buildRisks,
  buildWhyNow,
  classifySellability,
  rankingPriority,
  scoreFromKnown,
  verifySellabilityInvariants,
} from "@/lib/intelligence/sellability";

type JsonMap = Record<string, unknown>;

type IntelligenceRow = {
  product_id: string;
  normalized_title: string;
  brand_name: string | null;
  category: string | null;
  seller_name: string | null;
  image_url: string | null;
  currency: string | null;
  current_price: number | string | null;
  identity_confidence: number | string | null;
  price_confidence: number | string | null;
  demand_signal: number | string | null;
  metadata: JsonMap | null;
  last_seen_at: string | null;
};

type OfferRow = {
  id: string;
  product_id: string;
  seller_name: string | null;
  image_url: string | null;
  currency: string | null;
  price: number | string | null;
  currency_confidence: string | null;
  availability: string | null;
  shipping_price: number | string | null;
  observed_at: string;
  metadata: JsonMap | null;
};

type DemandRow = {
  id: string;
  product_id: string | null;
  signal_type: string;
  value: number | string | null;
  observed_at: string;
  metadata: JsonMap | null;
};

type MatchRow = {
  demand_observation_id: string;
  product_id: string;
};

type CjRow = {
  id: string;
  product_id: string | null;
  title: string;
  identity_status: string | null;
  identity_confidence: number | string | null;
  demand_product_candidate_id: string;
  inventory: number | null;
  sale_status: string | null;
};

type CandidateRow = {
  id: string;
  query: string | null;
  category: string | null;
};

type TestRow = {
  id: string;
  opportunity_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
};

type ResultRow = {
  test_id: string;
  orders: number | null;
  revenue: number | string | null;
  contribution_profit: number | string | null;
  roas: number | string | null;
  measurement_kind: string | null;
};

export type OpportunityBuildResult = {
  processed: number;
  upserted: number;
  testReady: number;
  rejected: number;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): JsonMap {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonMap;
  }
  return {};
}

function clampScore(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(Math.max(0, Math.min(100, value)).toFixed(4));
}

function clampUnit(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

function hoursSince(value: string | null): number | null {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 3_600_000;
}

function freshnessScore(hours: number | null): {
  score: number | null;
  confidence: number;
} {
  if (hours === null) return { score: null, confidence: 0 };
  if (hours <= 24) return { score: 95, confidence: 0.9 };
  if (hours <= 72) return { score: 85, confidence: 0.8 };
  if (hours <= 168) return { score: 70, confidence: 0.7 };
  if (hours <= 336) return { score: 50, confidence: 0.55 };
  return { score: 30, confidence: 0.4 };
}

function offerProvider(offer: OfferRow): string {
  const metadata = asRecord(offer.metadata);
  if (typeof metadata.provider === "string") return metadata.provider;
  if (offer.seller_name === "CJdropshipping") return "cj";
  return "unknown";
}

function isSourceOffer(offer: OfferRow): boolean {
  return offerProvider(offer) === "cj" || offer.seller_name === "CJdropshipping";
}

function offerCurrencyConfidence(offer: OfferRow): CurrencyConfidence {
  if (
    offer.currency_confidence === "high" ||
    offer.currency_confidence === "medium" ||
    offer.currency_confidence === "low" ||
    offer.currency_confidence === "unknown"
  ) {
    return offer.currency_confidence;
  }

  return assessCurrencyConfidence({
    currency: offer.currency,
    price: asNumber(offer.price),
    provider: offerProvider(offer),
  }).confidence;
}

function availabilityPositive(value: string | null): boolean | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (/(out of stock|sold out|unavailable|0)/.test(normalized)) return false;
  if (/(in stock|available|on sale|1|true)/.test(normalized)) return true;
  return null;
}

function apparelLike(category: string | null, title: string): boolean {
  const haystack = `${category ?? ""} ${title}`.toLowerCase();
  return /(apparel|shirt|dress|hoodie|pants|fashion|clothing|wear)/.test(
    haystack,
  );
}

export async function buildOpportunityIntelligence(): Promise<OpportunityBuildResult> {
  const supabase = createSupabaseAdminClient();

  const intelligenceResult = await supabase
    .from("product_intelligence")
    .select(
      "product_id, normalized_title, brand_name, category, seller_name, image_url, currency, current_price, identity_confidence, price_confidence, demand_signal, metadata, last_seen_at",
    );

  if (intelligenceResult.error) {
    throw new Error(intelligenceResult.error.message);
  }

  const intelligenceRows = (intelligenceResult.data ?? []) as IntelligenceRow[];

  const [
    offersResult,
    matchesResult,
    demandResult,
    cjResult,
    candidateResult,
    existingResult,
    testsResult,
    resultsResult,
  ] = await Promise.all([
    supabase
      .from("product_offers")
      .select(
        "id, product_id, seller_name, image_url, currency, price, currency_confidence, availability, shipping_price, observed_at, metadata",
      )
      .order("observed_at", { ascending: false }),
    supabase.from("demand_product_matches").select("demand_observation_id, product_id"),
    supabase
      .from("demand_observations")
      .select("id, product_id, signal_type, value, observed_at, metadata")
      .order("observed_at", { ascending: false }),
    supabase
      .from("demand_cj_products")
      .select(
        "id, product_id, title, identity_status, identity_confidence, demand_product_candidate_id, inventory, sale_status",
      ),
    supabase
      .from("demand_product_candidates")
      .select("id, query, category"),
    supabase
      .from("opportunity_intelligence")
      .select("id, product_id, first_test_ready_at, latest_test_status"),
    supabase
      .from("sales_tests")
      .select("id, opportunity_id, status, started_at, completed_at"),
    supabase
      .from("sales_test_results")
      .select(
        "test_id, orders, revenue, contribution_profit, roas, measurement_kind",
      ),
  ]);

  if (offersResult.error) throw new Error(offersResult.error.message);
  if (matchesResult.error) throw new Error(matchesResult.error.message);
  if (demandResult.error) throw new Error(demandResult.error.message);
  if (cjResult.error) throw new Error(cjResult.error.message);
  if (candidateResult.error) throw new Error(candidateResult.error.message);
  if (existingResult.error) throw new Error(existingResult.error.message);
  if (testsResult.error) throw new Error(testsResult.error.message);
  if (resultsResult.error) throw new Error(resultsResult.error.message);

  const offers = (offersResult.data ?? []) as OfferRow[];
  const matches = (matchesResult.data ?? []) as MatchRow[];
  const demands = (demandResult.data ?? []) as DemandRow[];
  const cjRows = (cjResult.data ?? []) as CjRow[];
  const candidates = (candidateResult.data ?? []) as CandidateRow[];
  const candidateById = new Map(candidates.map((row) => [row.id, row]));
  const existing = new Map(
    (existingResult.data ?? []).map((row) => [row.product_id as string, row]),
  );
  const tests = (testsResult.data ?? []) as TestRow[];
  const testResults = (resultsResult.data ?? []) as ResultRow[];
  const testsByOpportunity = new Map<string, TestRow[]>();
  for (const test of tests) {
    const list = testsByOpportunity.get(test.opportunity_id) ?? [];
    list.push(test);
    testsByOpportunity.set(test.opportunity_id, list);
  }
  const resultsByTest = new Map<string, ResultRow[]>();
  for (const result of testResults) {
    const list = resultsByTest.get(result.test_id) ?? [];
    list.push(result);
    resultsByTest.set(result.test_id, list);
  }

  const offersByProduct = new Map<string, OfferRow[]>();
  for (const offer of offers) {
    const list = offersByProduct.get(offer.product_id) ?? [];
    list.push(offer);
    offersByProduct.set(offer.product_id, list);
  }

  const demandById = new Map(demands.map((row) => [row.id, row]));
  const matchesByProduct = new Map<string, DemandRow[]>();
  for (const match of matches) {
    const demand = demandById.get(match.demand_observation_id);
    if (!demand) continue;
    const list = matchesByProduct.get(match.product_id) ?? [];
    list.push(demand);
    matchesByProduct.set(match.product_id, list);
  }

  for (const demand of demands) {
    if (!demand.product_id) continue;
    const list = matchesByProduct.get(demand.product_id) ?? [];
    if (!list.some((item) => item.id === demand.id)) {
      list.push(demand);
      matchesByProduct.set(demand.product_id, list);
    }
  }

  const cjByProduct = new Map<string, CjRow[]>();
  for (const row of cjRows) {
    if (!row.product_id) continue;
    const list = cjByProduct.get(row.product_id) ?? [];
    list.push(row);
    cjByProduct.set(row.product_id, list);
  }

  const computed: Array<{
    productId: string;
    payload: Record<string, unknown>;
    imageUrl: string | null;
    state: SellabilityState;
  }> = [];

  for (const row of intelligenceRows) {
    const productOffers = offersByProduct.get(row.product_id) ?? [];
    const productDemand = matchesByProduct.get(row.product_id) ?? [];
    const productCj = cjByProduct.get(row.product_id) ?? [];
    const metadata = asRecord(row.metadata);

    const marketOffers = productOffers.filter((offer) => !isSourceOffer(offer));
    const sourceOffers = productOffers.filter((offer) => isSourceOffer(offer));

    const marketOffer = marketOffers.find((offer) => {
      const confidence = offerCurrencyConfidence(offer);
      return confidence === "high" || confidence === "medium";
    }) ?? marketOffers[0] ?? null;

    const sourceOffer = sourceOffers.find((offer) => {
      const confidence = offerCurrencyConfidence(offer);
      return confidence === "high" || confidence === "medium";
    }) ?? sourceOffers[0] ?? null;

    const searchDemand = productDemand.filter(
      (item) => item.signal_type === "search_volume" || item.signal_type === "search_growth",
    );
    const socialDemand = productDemand.filter(
      (item) => item.signal_type === "social_mentions",
    );
    const reviewDemand = productDemand.filter(
      (item) => item.signal_type === "review_velocity",
    );

    const latestSearch = searchDemand[0] ?? null;
    const offerDemandQuery =
      sourceOffers
        .map((offer) => asRecord(offer.metadata).demand_query)
        .find((value) => typeof value === "string" && value.trim()) ??
      marketOffers
        .map((offer) => asRecord(offer.metadata).query)
        .find((value) => typeof value === "string" && value.trim());
    const candidateQuery = productCj
      .map((row) => candidateById.get(row.demand_product_candidate_id)?.query)
      .find((value) => typeof value === "string" && value.trim());
    const demandValue =
      asNumber(latestSearch?.value) ?? asNumber(metadata.demand_value);
    const demandQuery =
      typeof asRecord(latestSearch?.metadata).query === "string"
        ? String(asRecord(latestSearch?.metadata).query)
        : typeof metadata.demand_query === "string"
          ? String(metadata.demand_query)
          : typeof candidateQuery === "string"
            ? candidateQuery
            : typeof offerDemandQuery === "string"
              ? String(offerDemandQuery)
              : null;
    const demandCountry =
      typeof asRecord(latestSearch?.metadata).country === "string"
        ? String(asRecord(latestSearch?.metadata).country)
        : null;
    const demandSource =
      typeof asRecord(latestSearch?.metadata).provider === "string"
        ? String(asRecord(latestSearch?.metadata).provider)
        : demandValue !== null
          ? "demand_observations"
          : null;

    const searchGrowth =
      latestSearch && searchDemand.length > 1
        ? asNumber(latestSearch.value) !== null &&
          asNumber(searchDemand[1]?.value) !== null
          ? Number(asNumber(latestSearch.value)) -
            Number(asNumber(searchDemand[1]?.value))
          : null
        : null;

    const demandFresh = freshnessScore(hoursSince(latestSearch?.observed_at ?? row.last_seen_at));
    const sourceCount = new Set(
      productDemand
        .map((item) => asRecord(item.metadata).provider)
        .filter((value) => typeof value === "string"),
    ).size;

    const demandParts = [
      {
        score:
          demandValue !== null
            ? Math.max(0, Math.min(100, (demandValue / 1000) * 100))
            : asNumber(row.demand_signal) !== null
              ? Math.max(0, Math.min(100, Number(asNumber(row.demand_signal)) * 100))
              : null,
        weight: 0.45,
        confidence: demandValue !== null || asNumber(row.demand_signal) !== null ? 0.75 : 0,
      },
      {
        score:
          searchGrowth === null
            ? null
            : Math.max(0, Math.min(100, 50 + searchGrowth / 200)),
        weight: 0.2,
        confidence: searchGrowth === null ? 0 : 0.7,
      },
      {
        score:
          socialDemand[0] && asNumber(socialDemand[0].value) !== null
            ? Math.max(0, Math.min(100, Number(asNumber(socialDemand[0].value)) / 1000))
            : null,
        weight: 0.15,
        confidence: socialDemand[0] ? 0.65 : 0,
      },
      {
        score:
          reviewDemand[0] && asNumber(reviewDemand[0].value) !== null
            ? Math.max(0, Math.min(100, Number(asNumber(reviewDemand[0].value))))
            : null,
        weight: 0.1,
        confidence: reviewDemand[0] ? 0.6 : 0,
      },
      {
        score: sourceCount > 0 ? Math.min(100, sourceCount * 35) : null,
        weight: 0.1,
        confidence: sourceCount > 0 ? 0.8 : 0,
      },
    ];

    const demand = scoreFromKnown(demandParts);

    const identityRejected =
      productCj.some((item) => item.identity_status === "rejected_noise") &&
      productCj.every(
        (item) => item.identity_status !== "linked" && item.identity_status !== null,
      )
        ? true
        : metadata.identity_status === "rejected_noise";

    const relevance =
      demandQuery && row.normalized_title
        ? assessDemandRelevance({
            demandQuery,
            demandCategory: row.category,
            title: row.normalized_title,
            brand: row.brand_name,
            category: row.category,
            imageUrl: row.image_url,
          })
        : null;

    const rejectedByRelevance = relevance?.status === "rejected_noise";
    const identityConfidence =
      asNumber(row.identity_confidence) ?? relevance?.score ?? null;
    const identityConfirmed =
      !rejectedByRelevance &&
      !identityRejected &&
      identityConfidence !== null &&
      identityConfidence >= 0.65;

    const marketPrice = asNumber(marketOffer?.price);
    const sourceCost = asNumber(sourceOffer?.price);
    const marketCurrency = marketOffer?.currency ?? null;
    const sourceCurrency = sourceOffer?.currency ?? null;
    const marketConfidence = marketOffer
      ? offerCurrencyConfidence(marketOffer)
      : "unknown";
    const sourceConfidence = sourceOffer
      ? offerCurrencyConfidence(sourceOffer)
      : "unknown";

    const shippingPrice = asNumber(
      sourceOffer?.shipping_price ?? marketOffer?.shipping_price,
    );

    const profit = simulateContributionProfit({
      sellingPrice: marketPrice,
      sellingCurrency: marketCurrency,
      sellingCurrencyConfidence: marketConfidence,
      sellingProvider: marketOffer ? offerProvider(marketOffer) : null,
      sourceCost,
      sourceCurrency,
      sourceCurrencyConfidence: sourceConfidence,
      sourceProvider: sourceOffer ? offerProvider(sourceOffer) : "cj",
      internationalShipping: shippingPrice,
      domesticShipping: null,
      shippingCurrency: sourceOffer?.currency ?? marketOffer?.currency ?? null,
    });

    const marginScore =
      profit.calculable && profit.contributionMargin !== null
        ? Math.max(0, Math.min(100, 50 + profit.contributionMargin))
        : null;

    const sourceInventory = productCj
      .map((item) => item.inventory)
      .find((value) => typeof value === "number");
    const sourceAvailability =
      availabilityPositive(sourceOffer?.availability ?? null) ??
      availabilityPositive(productCj[0]?.sale_status ?? null);
    const supplyAvailable =
      sourceInventory !== undefined
        ? sourceInventory > 0
        : sourceAvailability === true
          ? true
          : sourceOffer !== null;

    const supplyScore = !sourceOffer
      ? null
      : sourceInventory !== undefined
        ? Math.max(0, Math.min(100, sourceInventory > 0 ? 80 : 25))
        : sourceAvailability === false
          ? 20
          : 70;

    const competitionScore =
      marketOffers.length === 0
        ? null
        : marketOffers.length === 1
          ? 90
          : marketOffers.length === 2
            ? 75
            : marketOffers.length <= 4
              ? 60
              : marketOffers.length <= 8
                ? 40
                : 25;

    const freshnessHours = hoursSince(
      latestSearch?.observed_at ??
        sourceOffer?.observed_at ??
        marketOffer?.observed_at ??
        row.last_seen_at,
    );
    const timing = scoreFromKnown([
      {
        score:
          searchGrowth === null
            ? null
            : Math.max(0, Math.min(100, 50 + searchGrowth / 150)),
        weight: 0.3,
        confidence: searchGrowth === null ? 0 : 0.7,
      },
      {
        score:
          demandCountry === "JP" && sourceOffer ? 78 : demandCountry === "JP" ? 55 : null,
        weight: 0.25,
        confidence: demandCountry === "JP" ? 0.7 : 0,
      },
      {
        score: competitionScore,
        weight: 0.2,
        confidence: competitionScore === null ? 0 : 0.65,
      },
      {
        score: demandFresh.score,
        weight: 0.25,
        confidence: demandFresh.confidence,
      },
    ]);

    const imageUrl = row.image_url ?? sourceOffer?.image_url ?? marketOffer?.image_url;
    const apparel = apparelLike(row.category, row.normalized_title);
    const creative = scoreFromKnown([
      {
        score: imageUrl ? 80 : null,
        weight: 0.35,
        confidence: imageUrl ? 0.7 : 0,
      },
      {
        score: imageUrl ? 60 : null,
        weight: 0.2,
        confidence: imageUrl ? 0.4 : 0,
      },
      {
        score: apparel ? 70 : imageUrl ? 40 : null,
        weight: 0.15,
        confidence: apparel ? 0.6 : imageUrl ? 0.3 : 0,
      },
      {
        score: imageUrl ? 65 : null,
        weight: 0.15,
        confidence: imageUrl ? 0.5 : 0,
      },
      {
        score: apparel ? 72 : null,
        weight: 0.15,
        confidence: apparel ? 0.55 : 0,
      },
    ]);

    const sellability = classifySellability({
      identityConfirmed,
      identityRejected: Boolean(identityRejected || rejectedByRelevance),
      sourceOfferConfirmed: Boolean(sourceOffer),
      priceCurrencyReliable:
        profit.currencyConfidence === "high" ||
        profit.currencyConfidence === "medium",
      supplyAvailable: Boolean(supplyAvailable && sourceOffer),
      shippingKnownOrExplicitUnknown: true,
      marketPriceAvailable: marketPrice !== null,
      imageAvailable: Boolean(imageUrl),
      marginCalculable: profit.calculable,
      productPagePossible: Boolean(imageUrl && row.normalized_title),
      creativePossible: Boolean(imageUrl),
      returnRiskAccounted: true,
      demandSufficient: demand.score !== null && demand.confidence >= 0.25,
    });

    const opportunity = scoreFromKnown([
      { score: demand.score, weight: 0.22, confidence: demand.confidence },
      { score: timing.score, weight: 0.16, confidence: timing.confidence },
      {
        score: marginScore,
        weight: 0.18,
        confidence: profit.calculable ? 0.7 : 0,
      },
      {
        score: supplyScore,
        weight: 0.12,
        confidence: supplyScore === null ? 0 : 0.7,
      },
      {
        score: competitionScore,
        weight: 0.08,
        confidence: competitionScore === null ? 0 : 0.6,
      },
      {
        score: sellability.score,
        weight: 0.14,
        confidence: 0.8,
      },
      {
        score: creative.score,
        weight: 0.1,
        confidence: creative.confidence,
      },
    ]);

    const whyNow = buildWhyNow({
      demandValue,
      demandSource,
      demandObservedAt: latestSearch?.observed_at ?? null,
      demandCountry,
      socialValue: asNumber(socialDemand[0]?.value),
      socialObservedAt: socialDemand[0]?.observed_at ?? null,
      sourceConfirmed: Boolean(sourceOffer),
      sourceObservedAt: sourceOffer?.observed_at ?? null,
      profitGap:
        profit.calculable &&
        profit.sellingPrice !== null &&
        profit.sourceCost !== null &&
        profit.sellingPrice > profit.sourceCost,
      marketOfferCount: marketOffers.length > 0 ? marketOffers.length : null,
      freshnessHours,
    });

    const weakerCurrency =
      marketOffer && sourceOffer
        ? profit.currencyConfidence
        : marketOffer
          ? marketConfidence
          : sourceOffer
            ? sourceConfidence
            : "unknown";

    const risks = buildRisks({
      shippingUnknown: profit.shippingUnknown,
      currencyConfidence: weakerCurrency,
      profitCalculable: profit.calculable,
      incalculableReason: profit.incalculableReason,
      identityConfidence,
      missing: sellability.missing,
    });

    const provenance: ProvenanceEntry[] = [
      asProvenance(
        "demand",
        demand.score === null ? "derived" : "observed",
        demandSource ?? "none",
        demand.score,
        latestSearch?.observed_at,
        demand.score === null ? "unknown_demand" : undefined,
      ),
      asProvenance(
        "market_price",
        marketPrice === null ? "derived" : "observed",
        marketOffer ? offerProvider(marketOffer) : "none",
        marketPrice,
        marketOffer?.observed_at,
      ),
      asProvenance(
        "source_cost",
        sourceCost === null ? "derived" : "observed",
        sourceOffer ? offerProvider(sourceOffer) : "none",
        sourceCost,
        sourceOffer?.observed_at,
      ),
      ...profit.provenance,
    ];

    const existingRow = existing.get(row.product_id);
    const relatedTests = existingRow?.id
      ? testsByOpportunity.get(existingRow.id as string) ?? []
      : [];
    const observedResults = relatedTests
      .flatMap((test) => resultsByTest.get(test.id) ?? [])
      .filter((result) => result.measurement_kind === "observed");
    const latestObserved = observedResults[0] ?? null;
    const firstReady =
      sellability.state === "TEST_READY"
        ? (existingRow?.first_test_ready_at as string | null) ??
          new Date().toISOString()
        : (existingRow?.first_test_ready_at as string | null) ?? null;

    const payload = {
      product_id: row.product_id,
      demand_score: clampScore(demand.score),
      timing_score: clampScore(timing.score),
      margin_score: clampScore(marginScore),
      supply_score: clampScore(supplyScore),
      competition_score: clampScore(competitionScore),
      sellability_score: clampScore(sellability.score),
      creative_score: clampScore(creative.score),
      opportunity_score: clampScore(opportunity.score),
      demand_confidence: clampUnit(demand.confidence),
      timing_confidence: clampUnit(timing.confidence),
      margin_confidence: clampUnit(profit.calculable ? 0.7 : 0),
      supply_confidence: clampUnit(supplyScore === null ? 0 : 0.7),
      overall_confidence: clampUnit(opportunity.confidence),
      sellability_state: sellability.state,
      ranking_priority: rankingPriority({
        state: sellability.state,
        opportunityScore: opportunity.score,
        overallConfidence: opportunity.confidence,
        freshnessHours,
        supplyConfirmed: Boolean(sourceOffer),
      }),
      why_now: whyNow,
      risks,
      market_price: marketPrice,
      market_currency: marketCurrency,
      source_cost: sourceCost,
      source_currency: sourceCurrency,
      currency_confidence: weakerCurrency,
      contribution_profit: profit.contributionProfit,
      contribution_margin:
        profit.contributionMargin === null
          ? null
          : Number(Math.max(-9999.9999, Math.min(9999.9999, profit.contributionMargin)).toFixed(4)),
      profit_calculable: profit.calculable,
      image_url: imageUrl,
      product_name: row.normalized_title,
      first_test_ready_at: firstReady,
      latest_test_status: existingRow?.latest_test_status ?? null,
      metadata: {
        scoring_version: "opportunity_v1",
        missing: sellability.missing,
        provenance,
        profit_lines: profit.lines,
        profit_incalculable_reason: profit.incalculableReason,
        shipping_unknown: profit.shippingUnknown,
        demand_query: demandQuery,
        demand_value: demandValue,
        search_growth: searchGrowth,
        social_signal: asNumber(socialDemand[0]?.value),
        review_velocity: asNumber(reviewDemand[0]?.value),
        source_count: sourceCount,
        observation_freshness_hours: freshnessHours,
        market_offer_count: marketOffers.length,
        source_offer_count: sourceOffers.length,
        identity_confidence: identityConfidence,
        identity_rejected: Boolean(identityRejected || rejectedByRelevance),
        measured: latestObserved
          ? {
              kind: "observed",
              orders: latestObserved.orders,
              revenue: asNumber(latestObserved.revenue),
              contribution_profit: asNumber(latestObserved.contribution_profit),
              roas: asNumber(latestObserved.roas),
            }
          : null,
        estimated: {
          kind: "estimated",
          contribution_profit: profit.contributionProfit,
          contribution_margin: profit.contributionMargin,
        },
        creative: {
          image_quality: imageUrl ? "unknown" : null,
          product_visibility: imageUrl ? "unknown" : null,
          model_generation_possible: apparel,
          creative_variation: Boolean(imageUrl),
          social_fit: apparel,
          video_fit: null,
          cvr_assumption: false,
        },
        updated_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    };

    computed.push({
      productId: row.product_id,
      payload,
      imageUrl: imageUrl ?? null,
      state: sellability.state,
    });
  }

  let upserted = 0;
  let testReady = 0;
  let rejected = 0;

  for (const item of computed) {
    const result = await supabase
      .from("opportunity_intelligence")
      .upsert(item.payload, { onConflict: "product_id" })
      .select("id")
      .single();

    if (result.error) {
      throw new Error(
        `Failed to upsert opportunity for ${item.productId}: ${result.error.message}`,
      );
    }

    upserted += 1;
    if (item.state === "TEST_READY") testReady += 1;
    if (item.state === "REJECTED") rejected += 1;

    if (item.imageUrl && result.data?.id) {
      await supabase.from("creative_variants").upsert(
        {
          opportunity_id: result.data.id,
          product_id: item.productId,
          variant_type: "source_image",
          image_url: item.imageUrl,
          metadata: {
            cvr_assumption: false,
            kind: "observed_source_image",
          },
        },
        { onConflict: "opportunity_id,variant_type" },
      );
    }
  }

  const readyProductIds = new Set(
    computed
      .filter((item) => item.state === "TEST_READY" || item.state === "SELLABLE")
      .map((item) => item.productId),
  );
  const candidateIds = [
    ...new Set(
      cjRows
        .filter(
          (row) => row.product_id && readyProductIds.has(row.product_id),
        )
        .map((row) => row.demand_product_candidate_id),
    ),
  ];

  if (candidateIds.length > 0) {
    await supabase
      .from("demand_product_candidates")
      .update({
        status: "opportunity",
        updated_at: new Date().toISOString(),
      })
      .in("id", candidateIds)
      .in("status", ["offer_found", "product_found"]);
  }

  return {
    processed: intelligenceRows.length,
    upserted,
    testReady,
    rejected,
  };
}

export function verifyOpportunityLoopInvariants() {
  const currency = verifyCurrencyConfidenceInvariants();
  const identity = verifyIdentityInvariants();
  const profit = verifyProfitInvariants();
  const sellability = verifySellabilityInvariants();

  return {
    ok: currency.ok && identity.ok && profit.ok && sellability.ok,
    currency,
    identity,
    profit,
    sellability,
  };
}
