import type {
  CurrencyConfidence,
  OpportunityRisk,
  ProvenanceEntry,
  SellabilityState,
  WhyNowItem,
} from "@/lib/domain/types";

export type SellabilityInput = {
  identityConfirmed: boolean;
  identityRejected: boolean;
  sourceOfferConfirmed: boolean;
  priceCurrencyReliable: boolean;
  supplyAvailable: boolean;
  shippingKnownOrExplicitUnknown: boolean;
  marketPriceAvailable: boolean;
  imageAvailable: boolean;
  marginCalculable: boolean;
  productPagePossible: boolean;
  creativePossible: boolean;
  returnRiskAccounted: boolean;
  demandSufficient: boolean;
};

export function classifySellability(input: SellabilityInput): {
  state: SellabilityState;
  score: number | null;
  missing: string[];
} {
  if (input.identityRejected) {
    return {
      state: "REJECTED",
      score: 10,
      missing: ["canonical_identity"],
    };
  }

  const checks: Array<[keyof SellabilityInput, string]> = [
    ["identityConfirmed", "canonical_identity"],
    ["sourceOfferConfirmed", "source_offer"],
    ["priceCurrencyReliable", "price_currency"],
    ["supplyAvailable", "supply"],
    ["shippingKnownOrExplicitUnknown", "shipping"],
    ["marketPriceAvailable", "market_price"],
    ["imageAvailable", "image"],
    ["marginCalculable", "margin"],
    ["productPagePossible", "product_page"],
    ["creativePossible", "creative"],
    ["returnRiskAccounted", "return_risk"],
    ["demandSufficient", "demand"],
  ];

  const missing = checks
    .filter(([key]) => input[key] !== true)
    .map(([, code]) => code);

  const knownCount = checks.length - missing.length;
  const score = Number(((knownCount / checks.length) * 100).toFixed(4));

  const testReady = missing.length === 0;

  if (testReady) {
    return { state: "TEST_READY", score, missing };
  }

  if (
    input.identityConfirmed &&
    input.sourceOfferConfirmed &&
    input.imageAvailable &&
    (input.marketPriceAvailable || input.marginCalculable)
  ) {
    return { state: "SELLABLE", score, missing };
  }

  if (input.demandSufficient && input.identityConfirmed && !input.identityRejected) {
    return { state: "WATCH", score, missing };
  }

  return { state: "NEEDS_DATA", score, missing };
}

export function verifySellabilityInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: SellabilityState; actual: SellabilityState }>;
} {
  const ready = classifySellability({
    identityConfirmed: true,
    identityRejected: false,
    sourceOfferConfirmed: true,
    priceCurrencyReliable: true,
    supplyAvailable: true,
    shippingKnownOrExplicitUnknown: true,
    marketPriceAvailable: true,
    imageAvailable: true,
    marginCalculable: true,
    productPagePossible: true,
    creativePossible: true,
    returnRiskAccounted: true,
    demandSufficient: true,
  });

  const noise = classifySellability({
    identityConfirmed: false,
    identityRejected: true,
    sourceOfferConfirmed: true,
    priceCurrencyReliable: true,
    supplyAvailable: true,
    shippingKnownOrExplicitUnknown: true,
    marketPriceAvailable: true,
    imageAvailable: true,
    marginCalculable: false,
    productPagePossible: true,
    creativePossible: true,
    returnRiskAccounted: true,
    demandSufficient: true,
  });

  const unconfirmed = classifySellability({
    identityConfirmed: false,
    identityRejected: false,
    sourceOfferConfirmed: true,
    priceCurrencyReliable: true,
    supplyAvailable: true,
    shippingKnownOrExplicitUnknown: true,
    marketPriceAvailable: true,
    imageAvailable: true,
    marginCalculable: false,
    productPagePossible: true,
    creativePossible: true,
    returnRiskAccounted: true,
    demandSufficient: true,
  });

  const cases = [
    { name: "complete_fixture_is_test_ready", expected: "TEST_READY" as const, actual: ready.state },
    { name: "noise_identity_rejected", expected: "REJECTED" as const, actual: noise.state },
    {
      name: "identity_unconfirmed_is_needs_data",
      expected: "NEEDS_DATA" as const,
      actual: unconfirmed.state,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}

export function scoreFromKnown(
  parts: Array<{ score: number | null; weight: number; confidence: number }>,
): { score: number | null; confidence: number } {
  const known = parts.filter(
    (part): part is { score: number; weight: number; confidence: number } =>
      part.score !== null && Number.isFinite(part.score),
  );

  if (known.length === 0) {
    return { score: null, confidence: 0 };
  }

  const weightSum = known.reduce((sum, part) => sum + part.weight, 0);
  const allWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const score =
    known.reduce((sum, part) => sum + part.score * part.weight, 0) / weightSum;
  const avgConfidence =
    known.reduce((sum, part) => sum + part.confidence * part.weight, 0) /
    weightSum;
  const coverage = allWeight === 0 ? 0 : weightSum / allWeight;

  return {
    score: Number(Math.max(0, Math.min(100, score)).toFixed(4)),
    confidence: Number(Math.max(0, Math.min(1, coverage * avgConfidence)).toFixed(4)),
  };
}

export function buildWhyNow(args: {
  demandValue: number | null;
  demandSource: string | null;
  demandObservedAt: string | null;
  demandCountry: string | null;
  socialValue: number | null;
  socialObservedAt: string | null;
  sourceConfirmed: boolean;
  sourceObservedAt: string | null;
  profitGap: boolean;
  marketOfferCount: number | null;
  freshnessHours: number | null;
}): WhyNowItem[] {
  const items: WhyNowItem[] = [];

  if (args.demandValue !== null && args.demandValue > 0 && args.demandSource) {
    items.push({
      statement: `検索需要が観測された（${args.demandSource}）`,
      field: "demand",
      source: args.demandSource,
      observedAt: args.demandObservedAt,
    });
  }

  if (args.socialValue !== null && args.socialValue > 0) {
    items.push({
      statement: "SNS上の言及が観測された",
      field: "social_signal",
      source: "demand_observations.social_mentions",
      observedAt: args.socialObservedAt,
    });
  }

  if (
    args.demandCountry === "JP" &&
    args.sourceConfirmed &&
    args.demandValue !== null
  ) {
    items.push({
      statement: "日本の需要シグナルに対して海外供給が存在する",
      field: "japan_gap",
      source: "demand_observations+product_offers",
      observedAt: args.sourceObservedAt,
    });
  }

  if (args.profitGap) {
    items.push({
      statement: "市場価格と供給価格に観測された差がある",
      field: "margin",
      source: "product_offers",
    });
  }

  if (args.sourceConfirmed) {
    items.push({
      statement: "供給が確認された",
      field: "supply",
      source: "product_offers",
      observedAt: args.sourceObservedAt,
    });
  }

  if (
    args.marketOfferCount !== null &&
    args.marketOfferCount > 0 &&
    args.marketOfferCount <= 2
  ) {
    items.push({
      statement: "観測された市場出品数が少ない",
      field: "competition",
      source: "product_offers",
    });
  }

  if (args.freshnessHours !== null && args.freshnessHours <= 72) {
    items.push({
      statement: "最近観測されたシグナルがある",
      field: "freshness",
      source: "observations",
    });
  }

  return items;
}

export function buildRisks(args: {
  shippingUnknown: boolean;
  currencyConfidence: CurrencyConfidence | null;
  profitCalculable: boolean;
  incalculableReason: string | null;
  identityConfidence: number | null;
  missing: string[];
}): OpportunityRisk[] {
  const risks: OpportunityRisk[] = [];

  if (args.shippingUnknown) {
    risks.push({ code: "shipping_unconfirmed", message: "送料未確認" });
  }

  if (args.currencyConfidence && args.currencyConfidence !== "high") {
    risks.push({
      code: "currency_confidence",
      message: `通貨confidence ${args.currencyConfidence}`,
    });
  }

  if (!args.profitCalculable) {
    risks.push({
      code: "profit_incalculable",
      message: args.incalculableReason
        ? `利益計算不能（${args.incalculableReason}）`
        : "利益計算不能",
    });
  }

  if (args.identityConfidence !== null && args.identityConfidence < 0.7) {
    risks.push({
      code: "identity",
      message: "商品同一性のconfidenceが低い",
    });
  }

  if (args.missing.includes("demand")) {
    risks.push({ code: "demand_unknown", message: "需要シグナル不足" });
  }

  return risks;
}

export function rankingPriority(args: {
  state: SellabilityState;
  opportunityScore: number | null;
  overallConfidence: number;
  freshnessHours: number | null;
  supplyConfirmed: boolean;
  selectionScore?: number | null;
  selectionEligible?: boolean;
}): number {
  const stateRank: Record<SellabilityState, number> = {
    TEST_READY: 1,
    SELLABLE: 2,
    WATCH: 3,
    NEEDS_DATA: 4,
    REJECTED: 5,
  };

  const hours = args.freshnessHours;
  const freshnessBoost =
    hours === null || !Number.isFinite(hours)
      ? 0
      : Math.round(Math.max(0, 200 - Math.min(Math.max(hours, 0), 200)));
  const supplyBoost = args.supplyConfirmed ? 50 : 0;
  const gatePenalty = args.selectionEligible === false ? 400_000 : 0;
  const rankScore = args.selectionScore ?? args.opportunityScore ?? 0;

  return Math.round(
    (stateRank[args.state] ?? 4) * 1_000_000 +
      gatePenalty -
      Math.round(rankScore) * 1_000 -
      Math.round((args.overallConfidence || 0) * 100) * 10 -
      freshnessBoost -
      supplyBoost,
  );
}

export function asProvenance(
  field: string,
  kind: ProvenanceEntry["kind"],
  source: string,
  value: unknown,
  observedAt?: string | null,
  note?: string,
): ProvenanceEntry {
  return { field, kind, source, value, observedAt: observedAt ?? null, note };
}
