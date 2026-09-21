import { forecastInventory } from "@/lib/ordering/inventory-forecast";
import { evaluateOrderGates } from "@/lib/ordering/gates";
import {
  computeReorderPoint,
  recommendedOrderQuantity,
} from "@/lib/ordering/reorder-point";
import type { OrderingSettings } from "@/lib/ordering/types";

export type ReorderInput = {
  productId: string;
  opportunityId: string | null;
  productName: string;
  category: string | null;
  onHand: number | null;
  inbound: number | null;
  forecastUnits7d: number | null;
  forecastUnits30d: number | null;
  forecastUnits90d: number | null;
  forecastProfit30d: number | null;
  forecastConfidence: number | null;
  sourceCost: number | null;
  shippingCost: number | null;
  currency: string | null;
  currencyReliable: boolean;
  identityConfirmed: boolean;
  identityUnknown: boolean;
  supplierConfirmed: boolean;
  supplierName: string | null;
  supplierApiAvailable: boolean | null;
  shippable: boolean | null;
  complianceRisk: boolean | null;
  profitCalculable: boolean;
  leadTimeDays: number | null;
  safetyStock: number | null;
  minimumOrderQty: number | null;
  settings: OrderingSettings;
  spentToday: number | null;
  spentMonth: number | null;
  spentProduct: number | null;
  spentCategory: number | null;
  supplierRiskNote: string | null;
};

export type ReorderRecommendation = {
  productId: string;
  opportunityId: string | null;
  onHand: number | null;
  inbound: number | null;
  forecastUnits30d: number | null;
  averageDailySales: number | null;
  leadTimeDays: number | null;
  safetyStock: number | null;
  reorderPoint: number | null;
  recommendedQty: number | null;
  recommendedDate: string | null;
  estimatedCost: number | null;
  estimatedProfit: number | null;
  currency: string | null;
  confidence: number | null;
  orderState: string;
  rationale: string;
  missing: string[];
  evidence: Record<string, unknown>;
  inventoryForecasts: Array<ReturnType<typeof forecastInventory>>;
};

function averageDailyFromForecast(units30d: number | null): number | null {
  if (units30d === null) return null;
  return Number((units30d / 30).toFixed(4));
}

function buildRationale(args: {
  forecastUnits30d: number | null;
  onHand: number | null;
  leadTimeDays: number | null;
  reorderPoint: number | null;
  recommendedQty: number | null;
  supplierRiskNote: string | null;
}): string {
  const parts = [
    args.forecastUnits30d === null
      ? "30日販売予測は unknown です。"
      : `30日販売予測が${args.forecastUnits30d}個、`,
    args.onHand === null ? "現在庫は unknown です。" : `現在庫が${args.onHand}個、`,
    args.leadTimeDays === null
      ? "リードタイムは unknown です。"
      : `リードタイムが${args.leadTimeDays}日、`,
    args.reorderPoint === null
      ? "Reorder Point は unknown です。"
      : `Reorder Pointが${args.reorderPoint}個のため、`,
    args.recommendedQty === null
      ? "推奨発注数は計算不能です。"
      : `推奨発注数は${args.recommendedQty}個です。`,
  ];

  if (args.supplierRiskNote) {
    parts.push(`供給リスク: ${args.supplierRiskNote}。数量は自動増加していません。`);
  }

  return parts.join(" ");
}

export function recommendReorder(input: ReorderInput): ReorderRecommendation {
  const leadTimeDays = input.leadTimeDays ?? input.settings.defaultLeadTimeDays;
  const safetyStock = input.safetyStock ?? input.settings.defaultSafetyStock;
  const averageDailySales = averageDailyFromForecast(input.forecastUnits30d);
  const reorder = computeReorderPoint({
    averageDailySales,
    leadTimeDays,
    safetyStock,
  });
  const recommendedQty = recommendedOrderQuantity({
    forecastUnits30d: input.forecastUnits30d,
    onHand: input.onHand,
    inbound: input.inbound,
    safetyStock,
    minimumOrderQty: input.minimumOrderQty,
  });

  const unitCost =
    input.sourceCost === null
      ? null
      : input.sourceCost + (input.shippingCost ?? 0);
  const estimatedCost =
    recommendedQty === null || unitCost === null
      ? null
      : Number((recommendedQty * unitCost).toFixed(4));
  const estimatedProfit =
    recommendedQty === null || input.forecastProfit30d === null
      ? null
      : Number(input.forecastProfit30d.toFixed(4));

  const belowReorder =
    input.onHand !== null &&
    reorder.reorderPoint !== null &&
    input.onHand < reorder.reorderPoint;

  const qtyForGates = belowReorder || recommendedQty === null ? recommendedQty : recommendedQty;

  const gates = evaluateOrderGates(
    {
      identityConfirmed: input.identityConfirmed,
      identityUnknown: input.identityUnknown,
      supplierConfirmed: input.supplierConfirmed,
      sourceCost: input.sourceCost,
      currency: input.currency,
      currencyReliable: input.currencyReliable,
      shippable: input.shippable,
      complianceRisk: input.complianceRisk,
      profitCalculable: input.profitCalculable,
      forecastUnits30d: input.forecastUnits30d,
      onHand: input.onHand,
      recommendedQty: qtyForGates,
      estimatedCost,
      supplierApiAvailable: input.supplierApiAvailable,
      settings: input.settings,
      spentToday: input.spentToday,
      spentMonth: input.spentMonth,
      spentProduct: input.spentProduct,
      spentCategory: input.spentCategory,
      category: input.category,
    },
    input.forecastConfidence,
  );

  const recommendedDate =
    belowReorder && recommendedQty !== null && recommendedQty > 0
      ? new Date().toISOString().slice(0, 10)
      : null;

  const inventoryForecasts = ([7, 30, 90] as const).map((days) =>
    forecastInventory({
      onHand: input.onHand,
      inbound: input.inbound,
      forecastUnits:
        days === 7
          ? input.forecastUnits7d
          : days === 30
            ? input.forecastUnits30d
            : input.forecastUnits90d,
      horizonDays: days,
      confidence: input.forecastConfidence,
    }),
  );

  return {
    productId: input.productId,
    opportunityId: input.opportunityId,
    onHand: input.onHand,
    inbound: input.inbound,
    forecastUnits30d: input.forecastUnits30d,
    averageDailySales,
    leadTimeDays,
    safetyStock,
    reorderPoint: reorder.reorderPoint,
    recommendedQty:
      recommendedQty !== null && recommendedQty > 0 ? recommendedQty : recommendedQty,
    recommendedDate,
    estimatedCost,
    estimatedProfit,
    currency: input.currency,
    confidence: input.forecastConfidence,
    orderState: gates.orderState,
    rationale: buildRationale({
      forecastUnits30d: input.forecastUnits30d,
      onHand: input.onHand,
      leadTimeDays,
      reorderPoint: reorder.reorderPoint,
      recommendedQty,
      supplierRiskNote: input.supplierRiskNote,
    }),
    missing: [...gates.missing, ...gates.blocked],
    evidence: {
      reorder: reorder.evidence,
      gates,
      supplier_risk_note: input.supplierRiskNote,
      inventory_forecasts: inventoryForecasts.map((item) => item.evidence),
      note: "own_on_hand_is_not_cj_inventory",
    },
    inventoryForecasts,
  };
}

export function verifyRecommendInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const unknownStock = recommendReorder({
    productId: "p1",
    opportunityId: null,
    productName: "Demo",
    category: null,
    onHand: null,
    inbound: null,
    forecastUnits7d: 10,
    forecastUnits30d: 40,
    forecastUnits90d: 120,
    forecastProfit30d: 80,
    forecastConfidence: 0.8,
    sourceCost: 3,
    shippingCost: 1,
    currency: "USD",
    currencyReliable: true,
    identityConfirmed: true,
    identityUnknown: false,
    supplierConfirmed: true,
    supplierName: "CJ",
    supplierApiAvailable: true,
    shippable: true,
    complianceRisk: false,
    profitCalculable: true,
    leadTimeDays: 7,
    safetyStock: 10,
    minimumOrderQty: null,
    settings: {
      mode: "AUTO",
      dailyOrderLimit: null,
      perProductOrderLimit: null,
      monthlyOrderBudget: null,
      categoryBudgets: {},
      defaultLeadTimeDays: 7,
      defaultSafetyStock: 10,
    },
    spentToday: 0,
    spentMonth: 0,
    spentProduct: 0,
    spentCategory: 0,
    supplierRiskNote: null,
  });

  const cases = [
    {
      name: "missing_own_stock_blocks_order",
      expected: true,
      actual:
        unknownStock.orderState === "UNKNOWN_BLOCKED" &&
        unknownStock.missing.includes("own_inventory_unknown"),
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
