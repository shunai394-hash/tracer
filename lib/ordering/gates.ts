import {
  confidenceBand,
  type ConfidenceBand,
  type OrderMode,
  type OrderState,
  type OrderingSettings,
} from "@/lib/ordering/types";

export type OrderGateInput = {
  identityConfirmed: boolean;
  identityUnknown: boolean;
  supplierConfirmed: boolean;
  sourceCost: number | null;
  currency: string | null;
  currencyReliable: boolean;
  shippable: boolean | null;
  complianceRisk: boolean | null;
  profitCalculable: boolean;
  forecastUnits30d: number | null;
  onHand: number | null;
  recommendedQty: number | null;
  estimatedCost: number | null;
  supplierApiAvailable: boolean | null;
  settings: OrderingSettings;
  spentToday: number | null;
  spentMonth: number | null;
  spentProduct: number | null;
  spentCategory: number | null;
  category: string | null;
};

export type OrderGateResult = {
  missing: string[];
  blocked: string[];
  budgetExceeded: boolean;
  canAuto: boolean;
  canPropose: boolean;
  orderState: OrderState;
  confidenceBand: ConfidenceBand;
};

export function evaluateOrderGates(
  input: OrderGateInput,
  confidence: number | null,
): OrderGateResult {
  const missing: string[] = [];
  const blocked: string[] = [];

  if (input.identityUnknown) missing.push("identity_unconfirmed");
  if (!input.identityConfirmed) blocked.push("identity_not_confirmed");
  if (!input.supplierConfirmed) missing.push("supplier_unconfirmed");
  if (input.sourceCost === null) missing.push("source_cost_unknown");
  if (!input.currency) missing.push("currency_unknown");
  if (!input.currencyReliable) blocked.push("currency_unreliable");
  if (input.shippable === null) missing.push("shippable_unknown");
  if (input.shippable === false) blocked.push("not_shippable");
  if (input.complianceRisk === null) missing.push("compliance_unknown");
  if (input.complianceRisk === true) blocked.push("compliance_risk");
  if (!input.profitCalculable) missing.push("profit_unknown");
  if (input.forecastUnits30d === null) missing.push("forecast_unknown");
  if (input.onHand === null) missing.push("own_inventory_unknown");
  if (input.recommendedQty === null) missing.push("order_qty_unknown");
  if (input.estimatedCost === null) missing.push("order_cost_unknown");
  if (input.supplierApiAvailable === null) missing.push("supplier_api_unknown");
  if (input.supplierApiAvailable === false) blocked.push("supplier_api_unavailable");

  const cost = input.estimatedCost;
  let budgetExceeded = false;
  if (cost !== null) {
    if (
      input.settings.dailyOrderLimit !== null &&
      input.spentToday !== null &&
      input.spentToday + cost > input.settings.dailyOrderLimit
    ) {
      blocked.push("daily_budget_exceeded");
      budgetExceeded = true;
    }
    if (
      input.settings.monthlyOrderBudget !== null &&
      input.spentMonth !== null &&
      input.spentMonth + cost > input.settings.monthlyOrderBudget
    ) {
      blocked.push("monthly_budget_exceeded");
      budgetExceeded = true;
    }
    if (
      input.settings.perProductOrderLimit !== null &&
      input.spentProduct !== null &&
      input.spentProduct + cost > input.settings.perProductOrderLimit
    ) {
      blocked.push("product_budget_exceeded");
      budgetExceeded = true;
    }
    if (
      input.category &&
      input.settings.categoryBudgets[input.category] !== undefined &&
      input.spentCategory !== null &&
      input.spentCategory + cost > input.settings.categoryBudgets[input.category]
    ) {
      blocked.push("category_budget_exceeded");
      budgetExceeded = true;
    }
  } else if (
    input.settings.dailyOrderLimit !== null ||
    input.settings.monthlyOrderBudget !== null ||
    input.settings.perProductOrderLimit !== null
  ) {
    missing.push("budget_check_cost_unknown");
  }

  const band = confidenceBand(confidence);
  const hardBlock = blocked.length > 0;
  const unknownBlock = missing.length > 0;
  const canPropose = !hardBlock && !unknownBlock && input.recommendedQty !== null && input.recommendedQty > 0;
  const canAuto =
    canPropose &&
    band === "high" &&
    input.settings.mode === "AUTO" &&
    input.supplierApiAvailable === true &&
    input.profitCalculable &&
    input.identityConfirmed;

  let orderState: OrderState;
  if (hardBlock || band === "unknown" || unknownBlock) {
    orderState = unknownBlock && !hardBlock ? "UNKNOWN_BLOCKED" : "ORDER_FORBIDDEN";
  } else if (band === "low") {
    orderState = "AUTO_FORBIDDEN";
  } else if (band === "medium" || input.settings.mode !== "AUTO") {
    orderState = "NEEDS_APPROVAL";
  } else if (canAuto) {
    orderState = "AUTO_CANDIDATE";
  } else {
    orderState = "AUTO_FORBIDDEN";
  }

  return {
    missing,
    blocked,
    budgetExceeded,
    canAuto,
    canPropose,
    orderState,
    confidenceBand: band,
  };
}

export function verifyOrderGateInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const settings: OrderingSettings = {
    mode: "AUTO",
    dailyOrderLimit: null,
    perProductOrderLimit: null,
    monthlyOrderBudget: null,
    categoryBudgets: {},
    defaultLeadTimeDays: 7,
    defaultSafetyStock: 10,
  };

  const unknownProfit = evaluateOrderGates(
    {
      identityConfirmed: true,
      identityUnknown: false,
      supplierConfirmed: true,
      sourceCost: 3,
      currency: "USD",
      currencyReliable: true,
      shippable: true,
      complianceRisk: false,
      profitCalculable: false,
      forecastUnits30d: 20,
      onHand: 5,
      recommendedQty: 25,
      estimatedCost: 75,
      supplierApiAvailable: true,
      settings,
      spentToday: 0,
      spentMonth: 0,
      spentProduct: 0,
      spentCategory: 0,
      category: "auto",
    },
    0.8,
  );

  const ready = evaluateOrderGates(
    {
      identityConfirmed: true,
      identityUnknown: false,
      supplierConfirmed: true,
      sourceCost: 3,
      currency: "USD",
      currencyReliable: true,
      shippable: true,
      complianceRisk: false,
      profitCalculable: true,
      forecastUnits30d: 20,
      onHand: 5,
      recommendedQty: 25,
      estimatedCost: 75,
      supplierApiAvailable: true,
      settings,
      spentToday: 0,
      spentMonth: 0,
      spentProduct: 0,
      spentCategory: 0,
      category: "auto",
    },
    0.82,
  );

  const cases = [
    {
      name: "unknown_profit_blocks_auto",
      expected: true,
      actual:
        unknownProfit.canAuto === false &&
        unknownProfit.missing.includes("profit_unknown"),
    },
    {
      name: "complete_high_confidence_can_auto",
      expected: true,
      actual: ready.canAuto === true && ready.orderState === "AUTO_CANDIDATE",
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}

export function modeAllowsExecution(
  mode: OrderMode,
  approved: boolean,
  canAuto: boolean,
): boolean {
  if (mode === "MANUAL") return approved;
  if (mode === "APPROVAL") return approved;
  return canAuto;
}
