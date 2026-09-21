import { scoreFromKnown } from "@/lib/intelligence/sellability";
import type { SellabilityState } from "@/lib/domain/types";

export type SelectionGate =
  | "identity_rejected"
  | "identity_unconfirmed"
  | "currency_mismatch"
  | "selling_price_unknown"
  | "source_cost_unknown"
  | "demand_unknown";

export type SelectionInput = {
  identityRejected: boolean;
  identityUnconfirmed: boolean;
  identityScore: number | null;
  demandScore: number | null;
  demandConfidence: number;
  marketGapScore: number | null;
  marketGapConfidence: number;
  profitScore: number | null;
  profitCalculable: boolean;
  profitIncalculableReason: string | null;
  forecastScore: number | null;
  forecastConfidence: number;
  searchFitScore: number | null;
  searchFitConfidence: number;
  sellabilityScore: number | null;
  sellabilityState: SellabilityState;
  sellingPrice: number | null;
  sourceCost: number | null;
  supplyScore?: number | null;
  competitionScore?: number | null;
  accountFitScore?: number | null;
  accountFitConfidence?: number;
  filterExcluded?: boolean;
};

export type SelectionDimensionScores = {
  demand: number | null;
  supply: number | null;
  competition: number | null;
  profit: number | null;
  forecast: number | null;
  accountFit: number | null;
  search: number | null;
  sellability: number | null;
};

export type SelectionResult = {
  eligible: boolean;
  score: number | null;
  confidence: number;
  gates: SelectionGate[];
  blocked: SelectionGate[];
  dimensions: SelectionDimensionScores;
};

function forecastUnitsToScore(units: number | null, confidence: number): {
  score: number | null;
  confidence: number;
} {
  if (units === null || !Number.isFinite(units)) {
    return { score: null, confidence: 0 };
  }
  return {
    score: Math.max(0, Math.min(100, Math.log10(1 + units) * 40)),
    confidence,
  };
}

export function forecastToSelectionScore(
  units30d: number | null,
  confidence: number,
): { score: number | null; confidence: number } {
  return forecastUnitsToScore(units30d, confidence);
}

/**
 * DEMAND × SUPPLY × COMPETITION × PROFIT × FORECAST × ACCOUNT FIT × SEARCH × SELLABILITY
 * Unknown dimensions are skipped instead of treated as 0.
 */
export function evaluateSelection(input: SelectionInput): SelectionResult {
  const gates: SelectionGate[] = [];

  if (input.identityRejected) gates.push("identity_rejected");
  if (input.identityUnconfirmed) gates.push("identity_unconfirmed");
  if (input.profitIncalculableReason === "currency_mismatch_no_observed_fx") {
    gates.push("currency_mismatch");
  }
  if (input.sellingPrice === null) gates.push("selling_price_unknown");
  if (input.sourceCost === null) gates.push("source_cost_unknown");
  if (input.demandScore === null) gates.push("demand_unknown");

  const blocked = gates.filter(
    (gate) => gate === "identity_rejected" || gate === "identity_unconfirmed",
  );
  const eligible =
    blocked.length === 0 &&
    input.sellabilityState !== "REJECTED" &&
    input.filterExcluded !== true;

  const dimensions: SelectionDimensionScores = {
    demand: input.demandScore,
    supply: input.supplyScore ?? null,
    competition: input.competitionScore ?? null,
    profit: input.profitCalculable ? input.profitScore : null,
    forecast: input.forecastScore,
    accountFit: input.accountFitScore ?? null,
    search: input.searchFitScore,
    sellability: input.sellabilityScore,
  };

  const scored = scoreFromKnown([
    {
      score: input.demandScore,
      weight: 0.16,
      confidence: input.demandScore === null ? 0 : input.demandConfidence,
    },
    {
      score:
        input.identityScore === null
          ? null
          : Math.max(0, Math.min(100, input.identityScore * 100)),
      weight: 0.12,
      confidence: input.identityScore === null ? 0 : 0.8,
    },
    {
      score: input.marketGapScore,
      weight: 0.1,
      confidence: input.marketGapScore === null ? 0 : input.marketGapConfidence,
    },
    {
      score: dimensions.supply,
      weight: 0.08,
      confidence: dimensions.supply === null ? 0 : 0.6,
    },
    {
      score: dimensions.competition,
      weight: 0.08,
      confidence: dimensions.competition === null ? 0 : 0.6,
    },
    {
      score: dimensions.profit,
      weight: 0.12,
      confidence: input.profitCalculable ? 0.7 : 0,
    },
    {
      score: input.forecastScore,
      weight: 0.12,
      confidence: input.forecastScore === null ? 0 : input.forecastConfidence,
    },
    {
      score: dimensions.accountFit,
      weight: 0.06,
      confidence:
        dimensions.accountFit === null ? 0 : (input.accountFitConfidence ?? 0),
    },
    {
      score: input.searchFitScore,
      weight: 0.08,
      confidence: input.searchFitScore === null ? 0 : input.searchFitConfidence,
    },
    {
      score: input.sellabilityScore,
      weight: 0.08,
      confidence: input.sellabilityScore === null ? 0 : 0.8,
    },
  ]);

  return {
    eligible,
    score: scored.score,
    confidence: scored.confidence,
    gates,
    blocked,
    dimensions,
  };
}

export function verifySelectionInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const unknownProfit = evaluateSelection({
    identityRejected: false,
    identityUnconfirmed: false,
    identityScore: 0.8,
    demandScore: 70,
    demandConfidence: 0.7,
    marketGapScore: null,
    marketGapConfidence: 0,
    profitScore: null,
    profitCalculable: false,
    profitIncalculableReason: "missing_market_or_source_price",
    forecastScore: 40,
    forecastConfidence: 0.3,
    searchFitScore: 60,
    searchFitConfidence: 0.5,
    sellabilityScore: 50,
    sellabilityState: "WATCH",
    sellingPrice: null,
    sourceCost: 3.2,
  });

  const rejected = evaluateSelection({
    identityRejected: true,
    identityUnconfirmed: false,
    identityScore: 0.05,
    demandScore: 80,
    demandConfidence: 0.8,
    marketGapScore: 70,
    marketGapConfidence: 0.6,
    profitScore: 80,
    profitCalculable: true,
    profitIncalculableReason: null,
    forecastScore: 50,
    forecastConfidence: 0.4,
    searchFitScore: 70,
    searchFitConfidence: 0.6,
    sellabilityScore: 10,
    sellabilityState: "REJECTED",
    sellingPrice: 29,
    sourceCost: 3,
  });

  const cases = [
    {
      name: "unknown_profit_does_not_zero_selection",
      expected: true,
      actual:
        unknownProfit.eligible &&
        unknownProfit.score !== null &&
        unknownProfit.score > 0 &&
        unknownProfit.gates.includes("selling_price_unknown"),
    },
    {
      name: "rejected_identity_is_not_selectable",
      expected: true,
      actual: rejected.eligible === false && rejected.blocked.includes("identity_rejected"),
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
