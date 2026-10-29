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

import { isJapaneseProductTitle } from "../intelligence/japanese-product.ts";
import { meetsMinimumSellingPrice, MINIMUM_SELLING_PRICE_JPY } from "../commerce/minimum-selling-price.ts";

const NON_PHYSICAL_TITLE_PATTERNS = [
  /商品券/i,
  /デジタルギフト/i,
  /ギフトカード/i,
  /gift\s*card/i,
  /e[-\s]?gift/i,
  /voucher/i,
  /coupon/i,
  /download/i,
  /digital\s+(gift|product)/i,
];

function isNonPhysicalProductTitle(title: string | null): boolean {
  if (!title) return false;
  return NON_PHYSICAL_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

export type SalesTestGateResult = { eligible: boolean; reasons: string[]; warnings: string[] };

export function evaluateSalesTestGate(input: SalesTestGateInput): SalesTestGateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if ((input.requireRank ?? true) && input.rank === null) reasons.push("rank_unknown");
  if (!input.title) reasons.push("title_unknown");
  else if (!isJapaneseProductTitle(input.title)) reasons.push("japanese_title_required");
  if (isNonPhysicalProductTitle(input.title)) reasons.push("non_physical_product");
  if (input.sellingPrice === null) reasons.push("selling_price_unknown");
  else if (!Number.isFinite(input.sellingPrice) || input.sellingPrice <= 0) reasons.push("selling_price_invalid");
  else if (!meetsMinimumSellingPrice(input.sellingPrice)) reasons.push(`minimum_selling_price_below_${MINIMUM_SELLING_PRICE_JPY}`);
  if (!input.identityLinked || input.identityMethod === "title") reasons.push("identity_not_confirmed");
  if (input.identityConfidence !== undefined && (input.identityConfidence === null || !Number.isFinite(input.identityConfidence) || input.identityConfidence < 0.88)) reasons.push("identity_confidence_low");
  if (input.sourceCost === null) reasons.push("source_cost_unknown");
  else if (!Number.isFinite(input.sourceCost) || input.sourceCost < 0) reasons.push("source_cost_invalid");
  if (input.shippingCost === null || input.shippingUnknown) reasons.push("shipping_unknown");
  else if (!Number.isFinite(input.shippingCost) || input.shippingCost < 0) reasons.push("shipping_invalid");
  if (input.trackingAvailable !== true) reasons.push("tracking_unknown");
  if (input.apiAvailable !== true) reasons.push("supplier_api_unknown");
  // Unknown, zero, and negative contribution profit cannot enter a sales test.
  // A confirmed supplier variant does not need a marketplace product id, but
  // it still needs a calculable positive margin after cost, freight, and fees.
  if (!input.profitCalculable || input.currencyMismatch) reasons.push("profit_unknown");
  if (input.contributionProfit === null || !Number.isFinite(input.contributionProfit)) reasons.push("profit_amount_unknown");
  else if (input.contributionProfit <= 0) reasons.push("profit_not_positive");
  if (input.priceConfirmed !== undefined && input.priceConfirmed !== true) reasons.push("price_unconfirmed");
  if (input.inventoryConfirmed !== undefined && input.inventoryConfirmed !== true) reasons.push("inventory_unknown");
  if (input.inventory !== undefined && (input.inventory === null || !Number.isFinite(input.inventory) || input.inventory <= 0)) reasons.push("inventory_zero");
  if (input.orderable !== undefined && input.orderable !== true) reasons.push("supplier_not_orderable");
  if (input.supplierProductId !== undefined && !input.supplierProductId) reasons.push("supplier_product_unknown");
  if (input.supplierVariantId !== undefined && !input.supplierVariantId) reasons.push("supplier_variant_unknown");
  return { eligible: reasons.length === 0, reasons, warnings };
}

export function verifySalesTestGateInvariants(): { ok: boolean; cases: Array<{ name: string; expected: boolean; actual: boolean }> } {
  const ready = evaluateSalesTestGate({ rank: 1, title: "バスマット", sellingPrice: 3980, identityLinked: true, identityMethod: "jan", sourceCost: 12, shippingCost: 4, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 8, currencyMismatch: false });
  const englishTitle = evaluateSalesTestGate({ rank: 1, title: "Floor Mat", sellingPrice: 3980, identityLinked: false, identityMethod: "title", sourceCost: 12, shippingCost: 4, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 8, currencyMismatch: false });
  const supplyReady = evaluateSalesTestGate({ ...supplyReadyInput(), requireRank: false });
  const supplyInventoryBlocked = evaluateSalesTestGate({ ...supplyReadyInput(), inventory: 0, requireRank: false });
  const invalidPrice = evaluateSalesTestGate({ ...supplyReadyInput(), sellingPrice: 0, requireRank: false });
  const invalidEconomics = evaluateSalesTestGate({ ...supplyReadyInput(), sourceCost: -1, shippingCost: -1, requireRank: false });
  const giftCard = evaluateSalesTestGate({ ...supplyReadyInput(), title: "Amazon Gift Card", requireRank: false });
  const unknownProfit = evaluateSalesTestGate({ ...supplyReadyInput(), contributionProfit: null, profitCalculable: false, requireRank: false });
  const zeroProfit = evaluateSalesTestGate({ ...supplyReadyInput(), contributionProfit: 0, requireRank: false });
  const negativeProfit = evaluateSalesTestGate({ ...supplyReadyInput(), contributionProfit: -250, requireRank: false });
  const unknownShipping = evaluateSalesTestGate({ ...supplyReadyInput(), shippingCost: null, shippingUnknown: true, requireRank: false });
  const priceRaisedIntoLoss = evaluateSalesTestGate({ ...supplyReadyInput(), sourceCost: 5000, contributionProfit: -100, requireRank: false });
  const nativeSupplier = evaluateSalesTestGate({ ...supplyReadyInput(), identityMethod: "cj_supplier_variant", identityLinked: true, requireRank: false });
  const cases = [
    { name: "complete_observed_product_is_eligible", expected: true, actual: ready.eligible && ready.reasons.length === 0 },
    { name: "english_title_is_not_eligible", expected: true, actual: englishTitle.eligible === false && englishTitle.reasons.includes("japanese_title_required") },
    { name: "supply_ready_is_eligible_without_market_rank", expected: true, actual: supplyReady.eligible },
    { name: "native_supplier_variant_is_eligible_without_marketplace_id", expected: true, actual: nativeSupplier.eligible },
    { name: "supply_zero_inventory_is_blocked", expected: true, actual: supplyInventoryBlocked.eligible === false && supplyInventoryBlocked.reasons.includes("inventory_zero") },
    { name: "zero_price_is_blocked", expected: true, actual: invalidPrice.eligible === false && invalidPrice.reasons.includes("selling_price_invalid") },
    { name: "negative_costs_are_blocked", expected: true, actual: invalidEconomics.eligible === false && invalidEconomics.reasons.includes("source_cost_invalid") && invalidEconomics.reasons.includes("shipping_invalid") },
    { name: "gift_card_is_blocked", expected: true, actual: giftCard.eligible === false && giftCard.reasons.includes("non_physical_product") },
    { name: "unknown_profit_is_blocked", expected: true, actual: unknownProfit.eligible === false && unknownProfit.reasons.includes("profit_unknown") && unknownProfit.reasons.includes("profit_amount_unknown") },
    { name: "zero_profit_is_blocked", expected: true, actual: zeroProfit.eligible === false && zeroProfit.reasons.includes("profit_not_positive") },
    { name: "negative_profit_is_blocked", expected: true, actual: negativeProfit.eligible === false && negativeProfit.reasons.includes("profit_not_positive") },
    { name: "unknown_shipping_is_blocked", expected: true, actual: unknownShipping.eligible === false && unknownShipping.reasons.includes("shipping_unknown") },
    { name: "price_change_into_loss_is_blocked", expected: true, actual: priceRaisedIntoLoss.eligible === false && priceRaisedIntoLoss.reasons.includes("profit_not_positive") },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}

function supplyReadyInput(): SalesTestGateInput {
  return { rank: null, title: "サプライ商品", sellingPrice: 3980, identityLinked: true, identityMethod: "jan", identityConfidence: 0.95, sourceCost: 1000, shippingCost: 300, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 2680, currencyMismatch: false, priceConfirmed: true, inventoryConfirmed: true, inventory: 20, orderable: true, supplierProductId: "pid", supplierVariantId: "vid" };
}

export const SALES_TEST_GATE_PASSED = "sales_test_gate_passed";

export type SalesTestGateRow = { published?: unknown; pipeline_stage?: unknown; pipeline_status?: unknown; pipeline_reason?: unknown; selection_reasons?: unknown; title?: unknown };

export function hasPassedSalesTestGate(row: SalesTestGateRow): boolean {
  if (row.published !== true) return false;
  // The selection marker is durable gate provenance. Downstream channel failures
  // may overwrite pipeline_stage/status/reason, but must not invalidate another
  // channel's delivery. Explicitly blocked or unpublished rows still fail closed.
  if (row.pipeline_stage === "BLOCKED" || row.pipeline_status === "blocked") return false;
  if (!isJapaneseProductTitle(row.title)) return false;
  return Array.isArray(row.selection_reasons) && row.selection_reasons.includes(SALES_TEST_GATE_PASSED);
}
