export type RankingPoint = {
  rank: number;
  observedAt: string;
};

export type RankingVelocityResult = {
  currentRank: number | null;
  previousRank: number | null;
  change: number | null;
  velocity: number | null;
  improving: boolean | null;
  confidence: number;
  evidence: Record<string, unknown>;
};

/**
 * Ranking velocity is only computed from observed marketplace ranks.
 * Missing Amazon/Rakuten/Mercari ranks stay unknown.
 */
export function evaluateRankingVelocity(
  points: RankingPoint[],
): RankingVelocityResult {
  const valid = points
    .filter((point) => Number.isFinite(point.rank) && point.rank > 0)
    .sort(
      (a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime(),
    );

  if (valid.length === 0) {
    return {
      currentRank: null,
      previousRank: null,
      change: null,
      velocity: null,
      improving: null,
      confidence: 0,
      evidence: { note: "sales_rank_not_observed" },
    };
  }

  const current = valid[valid.length - 1];
  const previous = valid.length > 1 ? valid[valid.length - 2] : null;
  const change = previous ? previous.rank - current.rank : null;

  return {
    currentRank: current.rank,
    previousRank: previous?.rank ?? null,
    change,
    velocity: change,
    improving: change === null ? null : change > 0,
    confidence: previous ? 0.65 : 0.35,
    evidence: {
      current_rank: current.rank,
      previous_rank: previous?.rank ?? null,
      observed_at: current.observedAt,
    },
  };
}

export function verifyRankingVelocityInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const missing = evaluateRankingVelocity([]);
  const improved = evaluateRankingVelocity([
    { rank: 500, observedAt: "2026-09-01T00:00:00.000Z" },
    { rank: 200, observedAt: "2026-09-21T00:00:00.000Z" },
  ]);

  const cases = [
    {
      name: "missing_rank_is_unknown",
      expected: true,
      actual: missing.velocity === null && missing.improving === null,
    },
    {
      name: "500_to_200_is_improvement",
      expected: true,
      actual: improved.change === 300 && improved.improving === true,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
