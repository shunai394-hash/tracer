import type { ForecastKind } from "@/lib/intelligence/sales-forecast";
import type { MarketGapStatus } from "@/lib/intelligence/market-gap";
import type { SelectionGate } from "@/lib/intelligence/selection-score";
import type { SellabilityState } from "@/lib/domain/types";

export type RecommendationReason = {
  code: string;
  statement: string;
  field: string;
  kind: "observed" | "derived" | "estimated" | "unknown";
};

export type RecommendationInput = {
  productName: string;
  demandValue: number | null;
  searchGrowth: number | null;
  identityConfirmed: boolean;
  identityRejected: boolean;
  identityUnconfirmed: boolean;
  competitorCount: number | null;
  competitorPriceMin: number | null;
  competitorPriceMax: number | null;
  inventory: number | null;
  supplyAvailable: boolean;
  profitCalculable: boolean;
  sellingPrice: number | null;
  sourceCost: number | null;
  forecastUnits30d: number | null;
  forecastKind: ForecastKind;
  forecastConfidence: number;
  searchFitReasons: string[];
  marketGapStatus: MarketGapStatus;
  marketGapReasons: string[];
  selectionEligible: boolean;
  selectionGates: SelectionGate[];
  sellabilityState: SellabilityState;
  demandQuery: string | null;
};

export type RecommendationResult = {
  summary: string | null;
  reasons: RecommendationReason[];
};

function risingDemand(growth: number | null, demandValue: number | null): boolean {
  return growth !== null && growth > 0 && demandValue !== null;
}

export function buildRecommendation(input: RecommendationInput): RecommendationResult {
  const reasons: RecommendationReason[] = [];

  if (risingDemand(input.searchGrowth, input.demandValue)) {
    reasons.push({
      code: "demand_rising",
      statement: "需要が上昇している",
      field: "demand",
      kind: "observed",
    });
  } else if (input.demandValue !== null && input.demandValue > 0) {
    reasons.push({
      code: "demand_observed",
      statement: "検索需要が観測されている",
      field: "demand",
      kind: "observed",
    });
  }

  if (input.identityConfirmed) {
    reasons.push({
      code: "identity_confirmed",
      statement: "商品アイデンティティが確認されている",
      field: "identity",
      kind: "derived",
    });
  }

  if (input.competitorCount !== null && input.competitorCount <= 2) {
    reasons.push({
      code: "competition_low",
      statement: "観測された競合が少ない",
      field: "competition",
      kind: "observed",
    });
  } else if (input.competitorCount !== null && input.competitorCount >= 5) {
    reasons.push({
      code: "competition_high",
      statement: "観測された競合が多い",
      field: "competition",
      kind: "observed",
    });
  }

  if (
    input.competitorCount !== null &&
    input.competitorPriceMin !== null &&
    input.competitorPriceMax !== null &&
    input.competitorPriceMax > 0
  ) {
    const spread =
      (input.competitorPriceMax - input.competitorPriceMin) /
      input.competitorPriceMax;
    if (spread < 0.15 && input.competitorCount >= 3) {
      reasons.push({
        code: "price_pressure_high",
        statement: "価格競争が強い",
        field: "competition",
        kind: "observed",
      });
    } else if (spread >= 0.3) {
      reasons.push({
        code: "price_pressure_low",
        statement: "価格競争が弱い",
        field: "competition",
        kind: "observed",
      });
    }
  }

  if (input.inventory !== null && input.inventory > 0) {
    reasons.push({
      code: "supply_sufficient",
      statement: "供給が十分",
      field: "supply",
      kind: "observed",
    });
  } else if (input.inventory !== null && input.inventory <= 0) {
    reasons.push({
      code: "supply_insufficient",
      statement: "供給が不足",
      field: "supply",
      kind: "observed",
    });
  } else if (input.supplyAvailable) {
    reasons.push({
      code: "supply_confirmed",
      statement: "供給が確認されている",
      field: "supply",
      kind: "observed",
    });
  }

  if (input.profitCalculable) {
    reasons.push({
      code: "profit_confirmed",
      statement: "利益計算に必要なデータが揃っている",
      field: "profit",
      kind: "derived",
    });
  } else if (input.sellingPrice === null || input.sourceCost === null) {
    reasons.push({
      code: "profit_incomplete",
      statement: "利益データが不足",
      field: "profit",
      kind: "unknown",
    });
  }

  for (const statement of input.searchFitReasons) {
    if (statement.includes("検索意図が明確")) {
      reasons.push({
        code: "search_intent_clear",
        statement: "検索意図が明確",
        field: "search_fit",
        kind: "derived",
      });
    } else if (statement.includes("検索コンテンツ") || statement.includes("商品名と需要")) {
      reasons.push({
        code: "search_content_ready",
        statement: "検索コンテンツを作りやすい",
        field: "search_fit",
        kind: "derived",
      });
    } else if (statement.includes("AI検索")) {
      reasons.push({
        code: "ai_search_explainable",
        statement: "AI検索で説明しやすい",
        field: "search_fit",
        kind: "derived",
      });
    }
  }

  for (const statement of input.marketGapReasons) {
    if (!reasons.some((reason) => reason.statement === statement)) {
      reasons.push({
        code: "market_gap",
        statement,
        field: "market_gap",
        kind: "derived",
      });
    }
  }

  const unique = reasons.filter(
    (reason, index, list) =>
      list.findIndex((item) => item.code === reason.code) === index,
  );

  const summary = !input.selectionEligible
    ? input.identityRejected || input.identityUnconfirmed
      ? "商品アイデンティティが未確定のため、選定対象外"
      : "必須ゲートを満たしていないため、テスト優先度は低い"
    : unique.length > 0
      ? `${input.productName} は観測された需要と供給データに基づいて販売テスト候補になる`
      : null;

  return {
    summary,
    reasons: unique,
  };
}

export function verifyRecommendationInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const sparse = buildRecommendation({
    productName: "Unknown item",
    demandValue: null,
    searchGrowth: null,
    identityConfirmed: true,
    identityRejected: false,
    identityUnconfirmed: false,
    competitorCount: null,
    competitorPriceMin: null,
    competitorPriceMax: null,
    inventory: null,
    supplyAvailable: false,
    profitCalculable: false,
    sellingPrice: null,
    sourceCost: null,
    forecastUnits30d: null,
    forecastKind: "unknown",
    forecastConfidence: 0,
    searchFitReasons: [],
    marketGapStatus: "unknown",
    marketGapReasons: [],
    selectionEligible: true,
    selectionGates: ["demand_unknown", "selling_price_unknown"],
    sellabilityState: "NEEDS_DATA",
    demandQuery: null,
  });

  const rich = buildRecommendation({
    productName: "Toyota Prius Floor Mat",
    demandValue: 2000,
    searchGrowth: 400,
    identityConfirmed: true,
    identityRejected: false,
    identityUnconfirmed: false,
    competitorCount: 1,
    competitorPriceMin: 29,
    competitorPriceMax: 41,
    inventory: 80,
    supplyAvailable: true,
    profitCalculable: true,
    sellingPrice: 39,
    sourceCost: 8,
    forecastUnits30d: 22,
    forecastKind: "demand_proxy",
    forecastConfidence: 0.4,
    searchFitReasons: ["検索意図が明確", "AI検索で説明しやすい商品文脈が揃っている"],
    marketGapStatus: "gap",
    marketGapReasons: ["需要が観測され、観測された競合出品が少ない"],
    selectionEligible: true,
    selectionGates: [],
    sellabilityState: "SELLABLE",
    demandQuery: "toyota prius",
  });

  const cases = [
    {
      name: "does_not_infer_missing_competition",
      expected: true,
      actual: !sparse.reasons.some((reason) => reason.field === "competition"),
    },
    {
      name: "uses_observed_demand_and_identity",
      expected: true,
      actual:
        rich.reasons.some((reason) => reason.code === "demand_rising") &&
        rich.reasons.some((reason) => reason.code === "identity_confirmed") &&
        rich.reasons.some((reason) => reason.code === "profit_confirmed"),
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
