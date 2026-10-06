export type SalesTestGateInput = {
  rank: number | null;
  title: string | null;
  sellingPrice: number | null;
  identityLinked: boolean;
  identityMethod: string | null;
  identityConfidence?: number | null;
  sourceCost: number | null;
  shippingCost: number | null;
  trackingAvailable: boolean | null;
  apiAvailable: boolean | null;
  profitCalculable: boolean;
  shippingUnknown: boolean;
  contributionProfit: number | null;
  currencyMismatch: boolean;
  priceConfirmed?: boolean;
  inventoryConfirmed?: boolean;
  inventory?: number | null;
  orderable?: boolean;
  supplierProductId?: string | null;
  supplierVariantId?: string | null;
  requireRank?: boolean;
};

export function evaluateSalesTestGate(input: SalesTestGateInput): {
  eligible: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if ((input.requireRank ?? true) && input.rank === null) reasons.push("rank_unknown");
  if (!input.title) reasons.push("title_unknown");
  if (input.sellingPrice === null) reasons.push("selling_price_unknown");
  if (!input.identityLinked || input.identityMethod === "title") reasons.push("identity_not_confirmed");
  if (input.identityConfidence !== undefined && (input.identityConfidence === null || input.identityConfidence < 0.88)) reasons.push("identity_confidence_low");
  if (input.sourceCost === null) reasons.push("source_cost_unknown");
  if (input.shippingCost === null || input.shippingUnknown) reasons.push("shipping_unknown");
  if (input.trackingAvailable !== true) reasons.push("tracking_unknown");
  if (input.apiAvailable !== true) reasons.push("supplier_api_unknown");
  if (!input.profitCalculable || input.currencyMismatch) reasons.push("profit_unknown");
  if (input.contributionProfit !== null && input.contributionProfit <= 0) reasons.push("profit_not_positive");
  if (input.priceConfirmed !== undefined && input.priceConfirmed !== true) reasons.push("price_unconfirmed");
  if (input.inventoryConfirmed !== undefined && input.inventoryConfirmed !== true) reasons.push("inventory_unknown");
  if (input.inventory !== undefined && (input.inventory === null || input.inventory <= 0)) reasons.push("inventory_zero");
  if (input.orderable !== undefined && input.orderable !== true) reasons.push("supplier_not_orderable");
  if (input.supplierProductId !== undefined && !input.supplierProductId) reasons.push("supplier_product_unknown");
  if (input.supplierVariantId !== undefined && !input.supplierVariantId) reasons.push("supplier_variant_unknown");
  return { eligible: reasons.length === 0, reasons };
}

export function verifySalesTestGateInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const ready = evaluateSalesTestGate({
    rank: 1,
    title: "Floor Mat",
    sellingPrice: 3980,
    identityLinked: true,
    identityMethod: "jan",
    sourceCost: 12,
    shippingCost: 4,
    trackingAvailable: true,
    apiAvailable: true,
    profitCalculable: true,
    shippingUnknown: false,
    contributionProfit: 8,
    currencyMismatch: false,
  });
  const titleOnly = evaluateSalesTestGate({
    rank: 1,
    title: "Floor Mat",
    sellingPrice: 3980,
    identityLinked: false,
    identityMethod: "title",
    sourceCost: 12,
    shippingCost: 4,
    trackingAvailable: true,
    apiAvailable: true,
    profitCalculable: true,
    shippingUnknown: false,
    contributionProfit: 8,
    currencyMismatch: false,
  });
  const supplyReady = evaluateSalesTestGate({
    rank: null,
    title: "Supply product",
    sellingPrice: 3980,
    identityLinked: true,
    identityMethod: "jan",
    identityConfidence: 0.95,
    sourceCost: 1000,
    shippingCost: 300,
    trackingAvailable: true,
    apiAvailable: true,
    profitCalculable: true,
    shippingUnknown: false,
    contributionProfit: 2680,
    currencyMismatch: false,
    priceConfirmed: true,
    inventoryConfirmed: true,
    inventory: 20,
    orderable: true,
    supplierProductId: "pid",
    supplierVariantId: "vid",
    requireRank: false,
  });
  const supplyInventoryBlocked = evaluateSalesTestGate({
    ...supplyReadyInput(),
    inventory: 0,
    requireRank: false,
  });

  const cases = [
    { name: "complete_observed_product_is_eligible", expected: true, actual: ready.eligible },
    { name: "title_only_identity_is_not_eligible", expected: true, actual: titleOnly.eligible === false && titleOnly.reasons.includes("identity_not_confirmed") },
    { name: "supply_ready_is_eligible_without_market_rank", expected: true, actual: supplyReady.eligible },
    { name: "supply_zero_inventory_is_blocked", expected: true, actual: supplyInventoryBlocked.eligible === false && supplyInventoryBlocked.reasons.includes("inventory_zero") },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}

function supplyReadyInput(): SalesTestGateInput {
  return {
    rank: null,
    title: "Supply product",
    sellingPrice: 3980,
    identityLinked: true,
    identityMethod: "jan",
    identityConfidence: 0.95,
    sourceCost: 1000,
    shippingCost: 300,
    trackingAvailable: true,
    apiAvailable: true,
    profitCalculable: true,
    shippingUnknown: false,
    contributionProfit: 2680,
    currencyMismatch: false,
    priceConfirmed: true,
    inventoryConfirmed: true,
    inventory: 20,
    orderable: true,
    supplierProductId: "pid",
    supplierVariantId: "vid",
  };
}

export const SALES_TEST_GATE_PASSED = "sales_test_gate_passed";

export type SalesTestGateRow = {
  published?: unknown;
  pipeline_stage?: unknown;
  pipeline_status?: unknown;
  pipeline_reason?: unknown;
  selection_reasons?: unknown;
};

/** Gate provenance is a persisted state machine, not a free-form marker. */
export function hasPassedSalesTestGate(row: SalesTestGateRow): boolean {
  if (row.published !== true) return false;
  if (row.pipeline_status !== "published") return false;
  if (row.pipeline_stage !== "PUBLISHED" && row.pipeline_stage !== "BASE_PUBLISHED") return false;
  if (row.pipeline_reason !== SALES_TEST_GATE_PASSED) return false;
  return Array.isArray(row.selection_reasons) && row.selection_reasons.includes(SALES_TEST_GATE_PASSED);
}
