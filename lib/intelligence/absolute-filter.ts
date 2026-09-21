import type { SelectionSettings } from "@/lib/intelligence/selection-config";

export type ProfitState =
  | "PROFIT_OK"
  | "PROFIT_TOO_LOW"
  | "PROFIT_UNKNOWN";

export type FilterState =
  | "PASS"
  | "DATA_MISSING"
  | "CONDITION_FAIL";

export type AbsoluteFilterInput = {
  identityRejected: boolean;
  identityUnconfirmed: boolean;
  profitCalculable: boolean;
  contributionMargin: number | null;
  forecastUnits30d: number | null;
  forecastProfit30d: number | null;
  sellerCount: number | null;
  weightKg: number | null;
  category: string | null;
  hazardous: boolean | null;
  restricted: boolean | null;
  shippable: boolean | null;
  currencyMismatch: boolean;
  demandScore: number | null;
  settings: SelectionSettings;
};

export type AbsoluteFilterResult = {
  profitState: ProfitState;
  filterState: FilterState;
  excluded: boolean;
  reasons: string[];
  dataMissing: string[];
  conditionFail: string[];
};

export function evaluateAbsoluteFilter(
  input: AbsoluteFilterInput,
): AbsoluteFilterResult {
  const dataMissing: string[] = [];
  const conditionFail: string[] = [];

  if (input.identityRejected) conditionFail.push("identity_rejected");
  if (input.identityUnconfirmed) dataMissing.push("identity_unconfirmed");
  if (input.currencyMismatch) conditionFail.push("currency_mismatch");
  if (input.hazardous === true || input.restricted === true) {
    conditionFail.push("compliance_risk");
  }
  if (input.shippable === false) conditionFail.push("not_shippable");

  let profitState: ProfitState = "PROFIT_UNKNOWN";
  if (!input.profitCalculable || input.contributionMargin === null) {
    profitState = "PROFIT_UNKNOWN";
    dataMissing.push("profit_unknown");
  } else if (
    input.settings.minMarginPct !== null &&
    input.contributionMargin < input.settings.minMarginPct
  ) {
    profitState = "PROFIT_TOO_LOW";
    conditionFail.push("profit_too_low");
  } else {
    profitState = "PROFIT_OK";
  }

  if (input.demandScore === null) dataMissing.push("demand_unknown");

  if (
    input.settings.minForecastUnits30d !== null &&
    input.forecastUnits30d === null
  ) {
    dataMissing.push("forecast_units_unknown");
  } else if (
    input.settings.minForecastUnits30d !== null &&
    input.forecastUnits30d !== null &&
    input.forecastUnits30d < input.settings.minForecastUnits30d
  ) {
    conditionFail.push("forecast_units_below_min");
  }

  if (
    input.settings.minForecastProfit !== null &&
    input.forecastProfit30d === null
  ) {
    dataMissing.push("forecast_profit_unknown");
  } else if (
    input.settings.minForecastProfit !== null &&
    input.forecastProfit30d !== null &&
    input.forecastProfit30d < input.settings.minForecastProfit
  ) {
    conditionFail.push("forecast_profit_below_min");
  }

  if (input.settings.maxSellerCount !== null && input.sellerCount === null) {
    dataMissing.push("seller_count_unknown");
  } else if (
    input.settings.maxSellerCount !== null &&
    input.sellerCount !== null &&
    input.sellerCount > input.settings.maxSellerCount
  ) {
    conditionFail.push("seller_count_above_max");
  }

  if (input.settings.maxWeightKg !== null && input.weightKg === null) {
    dataMissing.push("weight_unknown");
  } else if (
    input.settings.maxWeightKg !== null &&
    input.weightKg !== null &&
    input.weightKg > input.settings.maxWeightKg
  ) {
    conditionFail.push("weight_above_max");
  }

  if (
    input.settings.allowedCategories.length > 0 &&
    (!input.category ||
      !input.settings.allowedCategories.includes(input.category))
  ) {
    conditionFail.push("category_not_allowed");
  }
  if (
    input.category &&
    input.settings.excludedCategories.includes(input.category)
  ) {
    conditionFail.push("category_excluded");
  }

  const excluded =
    conditionFail.includes("identity_rejected") ||
    conditionFail.includes("compliance_risk") ||
    conditionFail.includes("not_shippable") ||
    conditionFail.includes("currency_mismatch") ||
    conditionFail.includes("profit_too_low") ||
    conditionFail.includes("category_not_allowed") ||
    conditionFail.includes("category_excluded");

  const filterState: FilterState = excluded
    ? "CONDITION_FAIL"
    : dataMissing.length > 0
      ? "DATA_MISSING"
      : "PASS";

  return {
    profitState,
    filterState,
    excluded,
    reasons: [...conditionFail, ...dataMissing],
    dataMissing,
    conditionFail,
  };
}

export function verifyAbsoluteFilterInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const unknown = evaluateAbsoluteFilter({
    identityRejected: false,
    identityUnconfirmed: false,
    profitCalculable: false,
    contributionMargin: null,
    forecastUnits30d: 20,
    forecastProfit30d: null,
    sellerCount: 2,
    weightKg: null,
    category: "automobile",
    hazardous: null,
    restricted: null,
    shippable: null,
    currencyMismatch: false,
    demandScore: 70,
    settings: {
      minMarginPct: 20,
      minForecastUnits30d: null,
      maxSellerCount: null,
      minForecastProfit: null,
      maxWeightKg: null,
      allowedCategories: [],
      excludedCategories: [],
    },
  });

  const tooLow = evaluateAbsoluteFilter({
    identityRejected: false,
    identityUnconfirmed: false,
    profitCalculable: true,
    contributionMargin: 8,
    forecastUnits30d: 20,
    forecastProfit30d: 10,
    sellerCount: 2,
    weightKg: null,
    category: "automobile",
    hazardous: null,
    restricted: null,
    shippable: null,
    currencyMismatch: false,
    demandScore: 70,
    settings: {
      minMarginPct: 20,
      minForecastUnits30d: null,
      maxSellerCount: null,
      minForecastProfit: null,
      maxWeightKg: null,
      allowedCategories: [],
      excludedCategories: [],
    },
  });

  const cases = [
    {
      name: "unknown_profit_is_not_too_low",
      expected: true,
      actual:
        unknown.profitState === "PROFIT_UNKNOWN" &&
        unknown.filterState === "DATA_MISSING" &&
        unknown.excluded === false,
    },
    {
      name: "low_margin_is_condition_fail",
      expected: true,
      actual:
        tooLow.profitState === "PROFIT_TOO_LOW" &&
        tooLow.filterState === "CONDITION_FAIL",
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
