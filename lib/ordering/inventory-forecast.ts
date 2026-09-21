export type InventoryForecastInput = {
  onHand: number | null;
  inbound: number | null;
  forecastUnits: number | null;
  horizonDays: 7 | 30 | 90;
  confidence: number | null;
};

export type InventoryForecastResult = {
  horizonDays: 7 | 30 | 90;
  onHand: number | null;
  inbound: number | null;
  forecastUnits: number | null;
  projectedOnHand: number | null;
  confidence: number | null;
  evidence: Record<string, unknown>;
};

/**
 * Future stock = on_hand + inbound - forecast units.
 * Missing forecast or own inventory stays unknown. CJ stock is not own warehouse.
 */
export function forecastInventory(
  input: InventoryForecastInput,
): InventoryForecastResult {
  if (input.onHand === null || input.forecastUnits === null) {
    return {
      horizonDays: input.horizonDays,
      onHand: input.onHand,
      inbound: input.inbound,
      forecastUnits: input.forecastUnits,
      projectedOnHand: null,
      confidence: null,
      evidence: {
        note:
          input.onHand === null
            ? "own_on_hand_unknown"
            : "sales_forecast_unknown",
      },
    };
  }

  const inbound = input.inbound ?? 0;
  return {
    horizonDays: input.horizonDays,
    onHand: input.onHand,
    inbound: input.inbound,
    forecastUnits: input.forecastUnits,
    projectedOnHand: Number((input.onHand + inbound - input.forecastUnits).toFixed(4)),
    confidence: input.confidence,
    evidence: {
      formula: "on_hand + inbound - forecast_units",
      inbound_treated_as_zero: input.inbound === null,
    },
  };
}

export function verifyInventoryForecastInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const known = forecastInventory({
    onHand: 100,
    inbound: 0,
    forecastUnits: 80,
    horizonDays: 30,
    confidence: 0.5,
  });
  const unknownSales = forecastInventory({
    onHand: 100,
    inbound: 0,
    forecastUnits: null,
    horizonDays: 30,
    confidence: null,
  });

  const cases = [
    {
      name: "100_minus_80_is_20",
      expected: true,
      actual: known.projectedOnHand === 20,
    },
    {
      name: "unknown_forecast_does_not_invent_stock",
      expected: true,
      actual: unknownSales.projectedOnHand === null,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
