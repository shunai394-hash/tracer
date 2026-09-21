export type AnomalyKind = "spike" | "sustained_growth" | "none" | "unknown";

export function classifyAnomaly(args: {
  demandSpike: boolean | null;
  demandTrend: string | null;
  rankingImproving: boolean | null;
  sellerIncreasing: boolean | null;
  stockoutGap: boolean | null;
  socialMentions: number | null;
}): { kind: AnomalyKind; signals: string[] } {
  const signals: string[] = [];
  if (args.demandSpike === true) signals.push("demand_spike");
  if (args.rankingImproving === true) signals.push("ranking_improved");
  if (args.sellerIncreasing === true) signals.push("seller_increase");
  if (args.stockoutGap === true) signals.push("supply_gap");
  if (args.socialMentions !== null && args.socialMentions > 0) {
    signals.push("social_observed");
  }

  if (args.demandSpike === true && args.demandTrend !== "rising") {
    return { kind: "spike", signals };
  }
  if (args.demandTrend === "rising" && args.demandSpike !== true) {
    return { kind: "sustained_growth", signals };
  }
  if (signals.length === 0) {
    return {
      kind:
        args.demandTrend === null && args.rankingImproving === null
          ? "unknown"
          : "none",
      signals,
    };
  }
  return { kind: "none", signals };
}

export function verifyAnomalyInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const spike = classifyAnomaly({
    demandSpike: true,
    demandTrend: "surge",
    rankingImproving: null,
    sellerIncreasing: null,
    stockoutGap: null,
    socialMentions: null,
  });
  const growth = classifyAnomaly({
    demandSpike: false,
    demandTrend: "rising",
    rankingImproving: true,
    sellerIncreasing: null,
    stockoutGap: null,
    socialMentions: null,
  });

  const cases = [
    {
      name: "spike_is_not_sustained_growth",
      expected: true,
      actual: spike.kind === "spike",
    },
    {
      name: "rising_without_spike_is_sustained",
      expected: true,
      actual: growth.kind === "sustained_growth",
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
