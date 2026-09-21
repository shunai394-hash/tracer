export type MarketGapStatus =
  | "gap"
  | "contested"
  | "unknown"
  | "not_a_product";

export type MarketGapInput = {
  demandScore: number | null;
  demandValue: number | null;
  competitorCount: number | null;
  competitorPriceMin: number | null;
  competitorPriceMax: number | null;
  identityConfirmed: boolean;
  identityRejected: boolean;
  identityUnconfirmed: boolean;
};

export type MarketGapResult = {
  score: number | null;
  confidence: number;
  status: MarketGapStatus;
  evidence: Record<string, unknown>;
  reasons: string[];
};

function clampScore(value: number): number {
  return Number(Math.max(0, Math.min(100, value)).toFixed(4));
}

/**
 * Market gap is only claimed when demand AND observed competition exist.
 * Missing competitor counts are unknown, not "few competitors".
 */
export function evaluateMarketGap(input: MarketGapInput): MarketGapResult {
  const reasons: string[] = [];
  const evidence: Record<string, unknown> = {
    demand_score: input.demandScore,
    demand_value: input.demandValue,
    competitor_count: input.competitorCount,
    competitor_price_min: input.competitorPriceMin,
    competitor_price_max: input.competitorPriceMax,
    identity_confirmed: input.identityConfirmed,
    identity_rejected: input.identityRejected,
    identity_unconfirmed: input.identityUnconfirmed,
  };

  if (input.identityRejected || input.identityUnconfirmed) {
    return {
      score: null,
      confidence: 0,
      status: "not_a_product",
      evidence,
      reasons,
    };
  }

  const demandKnown =
    (input.demandScore !== null && Number.isFinite(input.demandScore)) ||
    (input.demandValue !== null && Number.isFinite(input.demandValue));
  const competitionKnown =
    input.competitorCount !== null && Number.isFinite(input.competitorCount);

  if (!demandKnown || !competitionKnown || !input.identityConfirmed) {
    return {
      score: null,
      confidence: 0,
      status: "unknown",
      evidence: {
        ...evidence,
        unknown_reason: !demandKnown
          ? "demand_unknown"
          : !competitionKnown
            ? "competition_unknown"
            : "identity_unconfirmed",
      },
      reasons,
    };
  }

  const demandScore =
    input.demandScore !== null
      ? input.demandScore
      : Math.max(0, Math.min(100, (Number(input.demandValue) / 1000) * 100));

  const competitorCount = Number(input.competitorCount);
  const competitionOpenness =
    competitorCount <= 1
      ? 90
      : competitorCount === 2
        ? 75
        : competitorCount <= 4
          ? 55
          : competitorCount <= 8
            ? 35
            : 20;

  const priceSpread =
    input.competitorPriceMin !== null &&
    input.competitorPriceMax !== null &&
    input.competitorPriceMax > 0
      ? (input.competitorPriceMax - input.competitorPriceMin) /
        input.competitorPriceMax
      : null;

  const pricePressure =
    priceSpread === null ? null : clampScore(100 - priceSpread * 80);

  const score = clampScore(
    demandScore * 0.45 +
      competitionOpenness * 0.4 +
      (pricePressure ?? competitionOpenness) * 0.15,
  );

  if (demandScore >= 40 && competitorCount <= 2) {
    reasons.push("需要が観測され、観測された競合出品が少ない");
  } else if (demandScore >= 40 && competitorCount >= 5) {
    reasons.push("需要は観測されているが、観測された競合出品が多い");
  }

  if (priceSpread !== null && priceSpread < 0.15 && competitorCount >= 3) {
    reasons.push("観測された競合価格の差が小さく、価格競争が強い");
  } else if (priceSpread !== null && priceSpread >= 0.3) {
    reasons.push("観測された競合価格に幅があり、価格競争は相対的に弱い");
  }

  return {
    score,
    confidence: priceSpread === null ? 0.55 : 0.7,
    status: demandScore >= 40 && competitorCount <= 2 ? "gap" : "contested",
    evidence: {
      ...evidence,
      competition_openness: competitionOpenness,
      price_spread: priceSpread,
      price_pressure: pricePressure,
    },
    reasons,
  };
}

export function verifyMarketGapInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: MarketGapStatus; actual: MarketGapStatus }>;
} {
  const unknownCompetition = evaluateMarketGap({
    demandScore: 80,
    demandValue: 2000,
    competitorCount: null,
    competitorPriceMin: null,
    competitorPriceMax: null,
    identityConfirmed: true,
    identityRejected: false,
    identityUnconfirmed: false,
  });

  const gap = evaluateMarketGap({
    demandScore: 80,
    demandValue: 2000,
    competitorCount: 1,
    competitorPriceMin: 29,
    competitorPriceMax: 39,
    identityConfirmed: true,
    identityRejected: false,
    identityUnconfirmed: false,
  });

  const rejected = evaluateMarketGap({
    demandScore: 80,
    demandValue: 2000,
    competitorCount: 1,
    competitorPriceMin: 29,
    competitorPriceMax: 39,
    identityConfirmed: false,
    identityRejected: true,
    identityUnconfirmed: false,
  });

  const cases = [
    {
      name: "missing_competitors_is_unknown",
      expected: "unknown" as const,
      actual: unknownCompetition.status,
    },
    {
      name: "demand_plus_few_competitors_is_gap",
      expected: "gap" as const,
      actual: gap.status,
    },
    {
      name: "rejected_identity_is_not_a_product",
      expected: "not_a_product" as const,
      actual: rejected.status,
    },
  ];

  return {
    ok:
      cases.every((item) => item.actual === item.expected) &&
      unknownCompetition.score === null &&
      gap.score !== null,
    cases,
  };
}
