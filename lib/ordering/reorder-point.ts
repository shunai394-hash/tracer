export type ReorderPointInput = {
  averageDailySales: number | null;
  leadTimeDays: number | null;
  safetyStock: number | null;
};

export type ReorderPointResult = {
  reorderPoint: number | null;
  averageDailySales: number | null;
  leadTimeDays: number | null;
  safetyStock: number | null;
  evidence: Record<string, unknown>;
};

export function computeReorderPoint(
  input: ReorderPointInput,
): ReorderPointResult {
  if (
    input.averageDailySales === null ||
    input.leadTimeDays === null ||
    input.safetyStock === null
  ) {
    return {
      reorderPoint: null,
      averageDailySales: input.averageDailySales,
      leadTimeDays: input.leadTimeDays,
      safetyStock: input.safetyStock,
      evidence: { note: "lead_time_or_sales_or_safety_unknown" },
    };
  }

  return {
    reorderPoint: Number(
      (input.averageDailySales * input.leadTimeDays + input.safetyStock).toFixed(4),
    ),
    averageDailySales: input.averageDailySales,
    leadTimeDays: input.leadTimeDays,
    safetyStock: input.safetyStock,
    evidence: {
      formula: "average_daily_sales * lead_time_days + safety_stock",
    },
  };
}

export function recommendedOrderQuantity(args: {
  forecastUnits30d: number | null;
  onHand: number | null;
  inbound: number | null;
  safetyStock: number | null;
  minimumOrderQty: number | null;
}): number | null {
  if (
    args.forecastUnits30d === null ||
    args.onHand === null ||
    args.safetyStock === null
  ) {
    return null;
  }

  const inbound = args.inbound ?? 0;
  const needed = args.forecastUnits30d + args.safetyStock - args.onHand - inbound;
  const qty = Math.max(0, needed);
  if (args.minimumOrderQty !== null && qty > 0 && qty < args.minimumOrderQty) {
    return args.minimumOrderQty;
  }
  return Number(qty.toFixed(4));
}

export function verifyReorderPointInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const known = computeReorderPoint({
    averageDailySales: 5,
    leadTimeDays: 7,
    safetyStock: 10,
  });
  const missing = computeReorderPoint({
    averageDailySales: 5,
    leadTimeDays: null,
    safetyStock: 10,
  });
  const qty = recommendedOrderQuantity({
    forecastUnits30d: 100,
    onHand: 30,
    inbound: 10,
    safetyStock: 20,
    minimumOrderQty: null,
  });

  const cases = [
    {
      name: "5x7_plus_10_is_45",
      expected: true,
      actual: known.reorderPoint === 45,
    },
    {
      name: "missing_lead_time_is_unknown",
      expected: true,
      actual: missing.reorderPoint === null,
    },
    {
      name: "100_plus_20_minus_30_minus_10_is_80",
      expected: true,
      actual: qty === 80,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
