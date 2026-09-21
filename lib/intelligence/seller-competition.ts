export type SellerObservation = {
  sellerName: string | null;
  price: number | null;
  observedAt: string;
};

export type SellerCompetitionResult = {
  sellerCount: number | null;
  sellerVelocity: number | null;
  competitionIncreasing: boolean | null;
  priceMin: number | null;
  priceMax: number | null;
  priceMedian: number | null;
  score: number | null;
  confidence: number;
  evidence: Record<string, unknown>;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function uniqueSellers(rows: SellerObservation[]): string[] {
  return [
    ...new Set(
      rows
        .map((row) => (row.sellerName ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export function evaluateSellerCompetition(
  offers: SellerObservation[],
): SellerCompetitionResult {
  if (offers.length === 0) {
    return {
      sellerCount: null,
      sellerVelocity: null,
      competitionIncreasing: null,
      priceMin: null,
      priceMax: null,
      priceMedian: null,
      score: null,
      confidence: 0,
      evidence: { note: "no_market_offers" },
    };
  }

  const byDay = new Map<string, SellerObservation[]>();
  for (const offer of offers) {
    const day = offer.observedAt.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(offer);
    byDay.set(day, list);
  }

  const days = [...byDay.keys()].sort();
  const latest = byDay.get(days[days.length - 1]) ?? [];
  const previous =
    days.length > 1 ? (byDay.get(days[days.length - 2]) ?? []) : [];
  const sellerCount = uniqueSellers(latest).length || uniqueSellers(offers).length;
  const previousCount = previous.length > 0 ? uniqueSellers(previous).length : null;
  const sellerVelocity =
    previousCount !== null ? sellerCount - previousCount : null;
  const prices = offers
    .map((offer) => offer.price)
    .filter((value): value is number => value !== null && value > 0);

  const score =
    sellerCount <= 1
      ? 90
      : sellerCount === 2
        ? 75
        : sellerCount <= 4
          ? 55
          : sellerCount <= 8
            ? 35
            : 20;

  return {
    sellerCount,
    sellerVelocity,
    competitionIncreasing:
      sellerVelocity === null ? null : sellerVelocity >= 5 || (previousCount !== null && sellerCount >= previousCount * 1.5),
    priceMin: prices.length > 0 ? Math.min(...prices) : null,
    priceMax: prices.length > 0 ? Math.max(...prices) : null,
    priceMedian: median(prices),
    score,
    confidence: previousCount === null ? 0.55 : 0.7,
    evidence: {
      days: days.length,
      latest_count: sellerCount,
      previous_count: previousCount,
    },
  };
}

export function verifySellerCompetitionInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const missing = evaluateSellerCompetition([]);
  const rising = evaluateSellerCompetition([
    { sellerName: "A", price: 10, observedAt: "2026-09-01T00:00:00.000Z" },
    { sellerName: "B", price: 12, observedAt: "2026-09-10T00:00:00.000Z" },
    { sellerName: "C", price: 11, observedAt: "2026-09-10T00:00:00.000Z" },
    { sellerName: "D", price: 9, observedAt: "2026-09-21T00:00:00.000Z" },
    { sellerName: "E", price: 15, observedAt: "2026-09-21T00:00:00.000Z" },
    { sellerName: "F", price: 13, observedAt: "2026-09-21T00:00:00.000Z" },
    { sellerName: "G", price: 14, observedAt: "2026-09-21T00:00:00.000Z" },
  ]);

  const cases = [
    {
      name: "no_offers_does_not_claim_low_competition",
      expected: true,
      actual: missing.sellerCount === null && missing.score === null,
    },
    {
      name: "seller_increase_is_detected",
      expected: true,
      actual:
        rising.sellerCount === 4 &&
        rising.sellerVelocity === 2 &&
        rising.priceMedian !== null,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
