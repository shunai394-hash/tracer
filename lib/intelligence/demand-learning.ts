export type DemandSalesLearningInput = {
  demandScore: number | null;
  demandTrend: string | null;
  forecastUnits30d: number | null;
  actualUnits: number | null;
};

export function learnDemandVersusSales(
  input: DemandSalesLearningInput,
): string | null {
  if (input.actualUnits === null) return null;

  const demandHigh =
    input.demandScore !== null && input.demandScore >= 60;
  const forecastMiss =
    input.forecastUnits30d !== null &&
    input.actualUnits < input.forecastUnits30d * 0.4;

  if (demandHigh && forecastMiss) {
    return "需要が高いのに販売につながらなかった";
  }

  if (
    demandHigh &&
    input.actualUnits === 0
  ) {
    return "需要は観測されているが購入は観測されていない";
  }

  if (
    input.forecastUnits30d !== null &&
    input.actualUnits > input.forecastUnits30d * 1.5
  ) {
    return "販売実績が需要予測を上回った";
  }

  return null;
}

export function verifyDemandLearningInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const missed = learnDemandVersusSales({
    demandScore: 80,
    demandTrend: "rising",
    forecastUnits30d: 50,
    actualUnits: 12,
  });

  const unknownActual = learnDemandVersusSales({
    demandScore: 80,
    demandTrend: "rising",
    forecastUnits30d: 50,
    actualUnits: null,
  });

  const cases = [
    {
      name: "high_demand_low_sales_is_noted",
      expected: true,
      actual: missed === "需要が高いのに販売につながらなかった",
    },
    {
      name: "missing_actual_is_not_invented",
      expected: true,
      actual: unknownActual === null,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
