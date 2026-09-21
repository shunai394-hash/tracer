export type ForecastErrorInput = {
  predictedUnits: number | null;
  actualUnits: number | null;
  predictedRevenue: number | null;
  actualRevenue: number | null;
  predictedProfit: number | null;
  actualProfit: number | null;
};

export type ForecastErrorResult = {
  errorUnits: number | null;
  errorRevenue: number | null;
  errorProfit: number | null;
  errorPct: number | null;
  comparable: boolean;
};

function diff(predicted: number | null, actual: number | null): number | null {
  if (predicted === null || actual === null) return null;
  return Number((actual - predicted).toFixed(4));
}

/**
 * Compare AI/explainable forecasts with observed sales.
 * Missing predicted or actual values stay unknown instead of becoming 0.
 */
export function compareForecastToActual(
  input: ForecastErrorInput,
): ForecastErrorResult {
  const errorUnits = diff(input.predictedUnits, input.actualUnits);
  const errorRevenue = diff(input.predictedRevenue, input.actualRevenue);
  const errorProfit = diff(input.predictedProfit, input.actualProfit);

  const errorPct =
    input.predictedUnits !== null &&
    input.actualUnits !== null &&
    input.predictedUnits !== 0
      ? Number(
          ((input.actualUnits - input.predictedUnits) / input.predictedUnits).toFixed(4),
        )
      : null;

  return {
    errorUnits,
    errorRevenue,
    errorProfit,
    errorPct,
    comparable: errorUnits !== null || errorRevenue !== null || errorProfit !== null,
  };
}

export function verifyForecastLearningInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const comparable = compareForecastToActual({
    predictedUnits: 50,
    actualUnits: 37,
    predictedRevenue: 1500,
    actualRevenue: 1110,
    predictedProfit: 200,
    actualProfit: 80,
  });

  const unknownActual = compareForecastToActual({
    predictedUnits: 50,
    actualUnits: null,
    predictedRevenue: 1500,
    actualRevenue: null,
    predictedProfit: 200,
    actualProfit: null,
  });

  const cases = [
    {
      name: "stores_negative_unit_error",
      expected: true,
      actual: comparable.errorUnits === -13 && comparable.comparable,
    },
    {
      name: "missing_actuals_are_unknown_not_zero",
      expected: true,
      actual:
        unknownActual.errorUnits === null &&
        unknownActual.comparable === false,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
