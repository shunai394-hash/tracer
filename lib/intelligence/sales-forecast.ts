export type ForecastKind =
  | "observed_run_rate"
  | "demand_proxy"
  | "blended"
  | "unknown";

export type ForecastHorizon = {
  days: 7 | 30 | 90;
  units: number | null;
  unitsLow: number | null;
  unitsHigh: number | null;
  revenue: number | null;
  contributionProfit: number | null;
  contributionMargin: number | null;
};

export type SalesForecastInput = {
  demandValue: number | null;
  searchGrowth: number | null;
  previousDemandValue: number | null;
  demandVelocity7d?: number | null;
  demandTrend?: string | null;
  demandStability?: string | null;
  demandSpike?: boolean | null;
  competitorCount: number | null;
  inventory: number | null;
  sellingPrice: number | null;
  contributionProfitPerUnit: number | null;
  contributionMargin: number | null;
  profitCalculable: boolean;
  identityRejected: boolean;
  observedOrders: number | null;
  observedRevenue: number | null;
  observedWindowDays: number | null;
};

export type SalesForecastResult = {
  modelId: "explainable_v1";
  kind: ForecastKind;
  confidence: number;
  horizon7d: ForecastHorizon;
  horizon30d: ForecastHorizon;
  horizon90d: ForecastHorizon;
  evidence: Record<string, unknown>;
  incalculableReasons: string[];
};

/**
 * Operating assumption for demand-only forecasts.
 * This is not observed sales and is never invented by the model/LLM.
 * Search volume snapshots are mapped to a conservative 30-day unit proxy.
 */
export const FORECAST_ASSUMPTIONS = {
  search_volume_to_30d_units_divisor: 100,
  growth_adjustment_cap: 1,
  demand_only_band: 0.5,
  observed_band: 0.25,
  blended_band: 0.35,
} as const;

function roundUnits(value: number): number {
  return Number(Math.max(0, value).toFixed(4));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function moneyFromUnits(
  units: number | null,
  unitValue: number | null,
): number | null {
  if (units === null || unitValue === null || !Number.isFinite(unitValue)) {
    return null;
  }
  return roundMoney(units * unitValue);
}

function applyBand(
  units: number | null,
  band: number,
): { low: number | null; high: number | null } {
  if (units === null) return { low: null, high: null };
  return {
    low: roundUnits(units * (1 - band)),
    high: roundUnits(units * (1 + band)),
  };
}

function scaleHorizon(units30d: number | null, days: 7 | 30 | 90): number | null {
  if (units30d === null) return null;
  return roundUnits(units30d * (days / 30));
}

function demandProxyUnits30d(args: {
  demandValue: number;
  searchGrowth: number | null;
  previousDemandValue: number | null;
  demandVelocity7d?: number | null;
  demandStability?: string | null;
  demandSpike?: boolean | null;
  competitorCount: number | null;
  inventory: number | null;
}): { units: number; evidence: Record<string, unknown> } {
  let units =
    args.demandValue / FORECAST_ASSUMPTIONS.search_volume_to_30d_units_divisor;

  let growthAdj = 1;
  const oneOffSpike =
    args.demandSpike === true || args.demandStability === "spike";
  if (oneOffSpike) {
    growthAdj = 1;
  } else if (args.demandVelocity7d !== null && args.demandVelocity7d !== undefined) {
    growthAdj =
      1 +
      Math.max(
        -FORECAST_ASSUMPTIONS.growth_adjustment_cap,
        Math.min(FORECAST_ASSUMPTIONS.growth_adjustment_cap, args.demandVelocity7d),
      );
    units *= growthAdj;
  } else if (
    args.searchGrowth !== null &&
    args.previousDemandValue !== null &&
    args.previousDemandValue > 0
  ) {
    const raw = args.searchGrowth / args.previousDemandValue;
    growthAdj =
      1 +
      Math.max(
        -FORECAST_ASSUMPTIONS.growth_adjustment_cap,
        Math.min(FORECAST_ASSUMPTIONS.growth_adjustment_cap, raw),
      );
    units *= growthAdj;
  }

  let competitionAdj: number | null = null;
  if (args.competitorCount !== null) {
    competitionAdj =
      args.competitorCount <= 1
        ? 1
        : args.competitorCount === 2
          ? 0.85
          : args.competitorCount <= 4
            ? 0.7
            : 0.5;
    units *= competitionAdj;
  }

  if (args.inventory !== null && args.inventory <= 0) {
    units = 0;
  } else if (args.inventory !== null) {
    units = Math.min(units, args.inventory);
  }

  return {
    units: roundUnits(units),
    evidence: {
      demand_value: args.demandValue,
      growth_adjustment: growthAdj,
      one_off_spike: oneOffSpike,
      demand_velocity_7d: args.demandVelocity7d ?? null,
      competition_adjustment: competitionAdj,
      inventory_cap: args.inventory,
      divisor: FORECAST_ASSUMPTIONS.search_volume_to_30d_units_divisor,
    },
  };
}

function observedRunRateUnits30d(args: {
  observedOrders: number;
  observedWindowDays: number | null;
}): number {
  const windowDays =
    args.observedWindowDays !== null && args.observedWindowDays > 0
      ? args.observedWindowDays
      : 30;
  return roundUnits((args.observedOrders / windowDays) * 30);
}

function buildHorizon(
  days: 7 | 30 | 90,
  units30d: number | null,
  band: number,
  input: SalesForecastInput,
): ForecastHorizon {
  const units = scaleHorizon(units30d, days);
  const range = applyBand(units, band);
  const revenue = moneyFromUnits(units, input.sellingPrice);
  const contributionProfit = input.profitCalculable
    ? moneyFromUnits(units, input.contributionProfitPerUnit)
    : null;

  return {
    days,
    units,
    unitsLow: range.low,
    unitsHigh: range.high,
    revenue,
    contributionProfit,
    contributionMargin: input.profitCalculable
      ? input.contributionMargin
      : null,
  };
}

export function forecastSales(input: SalesForecastInput): SalesForecastResult {
  const incalculableReasons: string[] = [];

  if (input.identityRejected) {
    return {
      modelId: "explainable_v1",
      kind: "unknown",
      confidence: 0,
      horizon7d: buildHorizon(7, null, 0, input),
      horizon30d: buildHorizon(30, null, 0, input),
      horizon90d: buildHorizon(90, null, 0, input),
      evidence: { identity_rejected: true },
      incalculableReasons: ["identity_rejected"],
    };
  }

  if (input.sellingPrice === null) {
    incalculableReasons.push("selling_price_unknown");
  }
  if (!input.profitCalculable || input.contributionProfitPerUnit === null) {
    incalculableReasons.push("profit_inputs_unknown");
  }
  if (input.demandValue === null && input.observedOrders === null) {
    incalculableReasons.push("demand_and_sales_unknown");
  }

  const hasObserved =
    input.observedOrders !== null && Number.isFinite(input.observedOrders);
  const hasDemand =
    input.demandValue !== null &&
    Number.isFinite(input.demandValue) &&
    input.demandValue > 0;

  if (!hasObserved && !hasDemand) {
    return {
      modelId: "explainable_v1",
      kind: "unknown",
      confidence: 0,
      horizon7d: buildHorizon(7, null, 0, input),
      horizon30d: buildHorizon(30, null, 0, input),
      horizon90d: buildHorizon(90, null, 0, input),
      evidence: {
        demand_value: input.demandValue,
        observed_orders: input.observedOrders,
      },
      incalculableReasons,
    };
  }

  let units30d: number | null = null;
  let kind: ForecastKind = "unknown";
  let confidence = 0;
  const evidence: Record<string, unknown> = {
    selling_price: input.sellingPrice,
    profit_calculable: input.profitCalculable,
    observed_orders: input.observedOrders,
    observed_window_days: input.observedWindowDays,
    demand_value: input.demandValue,
    search_growth: input.searchGrowth,
    competitor_count: input.competitorCount,
    inventory: input.inventory,
  };

  if (hasObserved && hasDemand) {
    const observed = observedRunRateUnits30d({
      observedOrders: Number(input.observedOrders),
      observedWindowDays: input.observedWindowDays,
    });
    const proxy = demandProxyUnits30d({
      demandValue: Number(input.demandValue),
      searchGrowth: input.searchGrowth,
      previousDemandValue: input.previousDemandValue,
      demandVelocity7d: input.demandVelocity7d,
      demandStability: input.demandStability,
      demandSpike: input.demandSpike,
      competitorCount: input.competitorCount,
      inventory: input.inventory,
    });
    units30d = roundUnits(observed * 0.7 + proxy.units * 0.3);
    kind = "blended";
    confidence = 0.72;
    evidence.observed_run_rate_30d = observed;
    evidence.demand_proxy = proxy.evidence;
  } else if (hasObserved) {
    units30d = observedRunRateUnits30d({
      observedOrders: Number(input.observedOrders),
      observedWindowDays: input.observedWindowDays,
    });
    kind = "observed_run_rate";
    confidence = 0.68;
    evidence.observed_run_rate_30d = units30d;
  } else {
    const proxy = demandProxyUnits30d({
      demandValue: Number(input.demandValue),
      searchGrowth: input.searchGrowth,
      previousDemandValue: input.previousDemandValue,
      demandVelocity7d: input.demandVelocity7d,
      demandStability: input.demandStability,
      demandSpike: input.demandSpike,
      competitorCount: input.competitorCount,
      inventory: input.inventory,
    });
    units30d = proxy.units;
    kind = "demand_proxy";
    confidence = 0.28;
    if (input.searchGrowth !== null) confidence += 0.08;
    if (input.competitorCount !== null) confidence += 0.08;
    if (input.inventory !== null) confidence += 0.06;
    confidence = Number(Math.min(0.55, confidence).toFixed(4));
    evidence.demand_proxy = proxy.evidence;
    evidence.kind_note =
      "demand_proxy_not_observed_sales_uses_operating_assumption";
  }

  const band =
    kind === "observed_run_rate"
      ? FORECAST_ASSUMPTIONS.observed_band
      : kind === "blended"
        ? FORECAST_ASSUMPTIONS.blended_band
        : FORECAST_ASSUMPTIONS.demand_only_band;

  return {
    modelId: "explainable_v1",
    kind,
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(4)),
    horizon7d: buildHorizon(7, units30d, band, input),
    horizon30d: buildHorizon(30, units30d, band, input),
    horizon90d: buildHorizon(90, units30d, Math.min(0.75, band + 0.15), input),
    evidence,
    incalculableReasons,
  };
}

export function verifyForecastInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const missingPrice = forecastSales({
    demandValue: 2000,
    searchGrowth: null,
    previousDemandValue: null,
    competitorCount: 1,
    inventory: 80,
    sellingPrice: null,
    contributionProfitPerUnit: null,
    contributionMargin: null,
    profitCalculable: false,
    identityRejected: false,
    observedOrders: null,
    observedRevenue: null,
    observedWindowDays: null,
  });

  const missingDemand = forecastSales({
    demandValue: null,
    searchGrowth: null,
    previousDemandValue: null,
    competitorCount: 1,
    inventory: 80,
    sellingPrice: 29.99,
    contributionProfitPerUnit: 4.5,
    contributionMargin: 15,
    profitCalculable: true,
    identityRejected: false,
    observedOrders: null,
    observedRevenue: null,
    observedWindowDays: null,
  });

  const demandOnly = forecastSales({
    demandValue: 2000,
    searchGrowth: 400,
    previousDemandValue: 1600,
    competitorCount: 1,
    inventory: 80,
    sellingPrice: 29.99,
    contributionProfitPerUnit: 4.5,
    contributionMargin: 15,
    profitCalculable: true,
    identityRejected: false,
    observedOrders: null,
    observedRevenue: null,
    observedWindowDays: null,
  });

  const cases = [
    {
      name: "missing_price_keeps_revenue_unknown",
      expected: true,
      actual:
        missingPrice.horizon30d.units !== null &&
        missingPrice.horizon30d.revenue === null &&
        missingPrice.horizon30d.contributionProfit === null,
    },
    {
      name: "missing_demand_and_sales_keeps_units_unknown",
      expected: true,
      actual:
        missingDemand.kind === "unknown" &&
        missingDemand.horizon30d.units === null,
    },
    {
      name: "demand_proxy_does_not_treat_unknown_as_zero",
      expected: true,
      actual:
        demandOnly.kind === "demand_proxy" &&
        demandOnly.horizon30d.units !== null &&
        demandOnly.horizon30d.units > 0 &&
        demandOnly.horizon7d.units !== null,
    },
    {
      name: "90d_is_scaled_from_30d_not_invented",
      expected: true,
      actual:
        demandOnly.horizon90d.units !== null &&
        demandOnly.horizon30d.units !== null &&
        Math.abs(demandOnly.horizon90d.units - demandOnly.horizon30d.units * 3) <
          0.01,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
