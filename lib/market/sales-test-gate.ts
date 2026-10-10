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
  /** Distinct supplier variants that claim the same demand item; anything but 1 is ambiguous. */
  supplierCandidateCount?: number;
  requireRank?: boolean;
};

import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishGradeIdentityMethod } from "@/lib/market/identifiers";

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

export function evaluateSalesTestGate(input: SalesTestGateInput): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if ((input.requireRank ?? true) && input.rank === null) reasons.push("rank_unknown");
  if (!input.title) reasons.push("title_unknown");
  else if (!isJapaneseProductTitle(input.title)) reasons.push("japanese_title_required");
  if (isNonPhysicalProductTitle(input.title)) reasons.push("non_physical_product");
  if (input.sellingPrice === null) reasons.push("selling_price_unknown");
  else if (!Number.isFinite(input.sellingPrice) || input.sellingPrice <= 0) reasons.push("selling_price_invalid");
  // Only barcode or brand+MPN identity may publish. ASIN, bare MPN, title,
  // image and supply discovery are candidate evidence, never a sale permit.
  if (!input.identityLinked || !isPublishGradeIdentityMethod(input.identityMethod)) reasons.push("identity_not_confirmed");
  if (input.supplierCandidateCount !== undefined && input.supplierCandidateCount !== 1) {
    reasons.push(input.supplierCandidateCount === 0 ? "supplier_candidate_missing" : "supplier_candidate_ambiguous");
  }
  if (input.identityConfidence !== undefined && (input.identityConfidence === null || !Number.isFinite(input.identityConfidence) || input.identityConfidence < 0.88)) reasons.push("identity_confidence_low");
  if (input.sourceCost === null) reasons.push("source_cost_unknown");
  else if (!Number.isFinite(input.sourceCost) || input.sourceCost < 0) reasons.push("source_cost_invalid");
  if (input.shippingCost === null || input.shippingUnknown) reasons.push("shipping_unknown");
  else if (!Number.isFinite(input.shippingCost) || input.shippingCost < 0) reasons.push("shipping_invalid");
  if (input.trackingAvailable !== true) reasons.push("tracking_unknown");
  if (input.apiAvailable !== true) reasons.push("supplier_api_unknown");
  if (!input.profitCalculable || input.currencyMismatch) reasons.push("profit_unknown");
  if (input.contributionProfit !== null && (!Number.isFinite(input.contributionProfit) || input.contributionProfit <= 0)) reasons.push("profit_not_positive");
  if (input.priceConfirmed !== undefined && input.priceConfirmed !== true) reasons.push("price_unconfirmed");
  if (input.inventoryConfirmed !== undefined && input.inventoryConfirmed !== true) reasons.push("inventory_unknown");
  if (input.inventory !== undefined && (input.inventory === null || !Number.isFinite(input.inventory) || input.inventory <= 0)) reasons.push("inventory_zero");
  if (input.orderable !== undefined && input.orderable !== true) reasons.push("supplier_not_orderable");
  if (input.supplierProductId !== undefined && !input.supplierProductId) reasons.push("supplier_product_unknown");
  if (input.supplierVariantId !== undefined && !input.supplierVariantId) reasons.push("supplier_variant_unknown");
  return { eligible: reasons.length === 0, reasons };
}

export function verifySalesTestGateInvariants(): { ok: boolean; cases: Array<{ name: string; expected: boolean; actual: boolean }> } {
  const ready = evaluateSalesTestGate({ rank: 1, title: "Floor Mat", sellingPrice: 3980, identityLinked: true, identityMethod: "jan", sourceCost: 12, shippingCost: 4, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 8, currencyMismatch: false });
  const englishTitle = evaluateSalesTestGate({ rank: 1, title: "Floor Mat", sellingPrice: 3980, identityLinked: false, identityMethod: "title", sourceCost: 12, shippingCost: 4, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 8, currencyMismatch: false });
  const supplyReady = evaluateSalesTestGate({ ...supplyReadyInput(), requireRank: false });
  const supplyInventoryBlocked = evaluateSalesTestGate({ ...supplyReadyInput(), inventory: 0, requireRank: false });
  const invalidPrice = evaluateSalesTestGate({ ...supplyReadyInput(), sellingPrice: 0, requireRank: false });
  const invalidEconomics = evaluateSalesTestGate({ ...supplyReadyInput(), sourceCost: -1, shippingCost: -1, requireRank: false });
  const giftCard = evaluateSalesTestGate({ ...supplyReadyInput(), title: "Amazon Gift Card", requireRank: false });
  const cases = [
    { name: "complete_observed_product_is_eligible", expected: true, actual: ready.eligible },
    { name: "english_title_is_not_eligible", expected: true, actual: englishTitle.eligible === false && englishTitle.reasons.includes("japanese_title_required") },
    { name: "supply_ready_is_eligible_without_market_rank", expected: true, actual: supplyReady.eligible },
    { name: "supply_zero_inventory_is_blocked", expected: true, actual: supplyInventoryBlocked.eligible === false && supplyInventoryBlocked.reasons.includes("inventory_zero") },
    { name: "zero_price_is_blocked", expected: true, actual: invalidPrice.eligible === false && invalidPrice.reasons.includes("selling_price_invalid") },
    { name: "negative_economics_are_blocked", expected: true, actual: invalidEconomics.eligible === false && invalidEconomics.reasons.includes("source_cost_invalid") && invalidEconomics.reasons.includes("shipping_invalid") },
    { name: "gift_card_is_blocked", expected: true, actual: giftCard.eligible === false && giftCard.reasons.includes("non_physical_product") },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}

function supplyReadyInput(): SalesTestGateInput {
  return { rank: null, title: "Supply product", sellingPrice: 3980, identityLinked: true, identityMethod: "jan", identityConfidence: 0.95, sourceCost: 1000, shippingCost: 300, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 2680, currencyMismatch: false, priceConfirmed: true, inventoryConfirmed: true, inventory: 20, orderable: true, supplierProductId: "pid", supplierVariantId: "vid" };
}

export const SALES_TEST_GATE_PASSED = "sales_test_gate_passed";

export type SalesTestGateRow = { published?: unknown; pipeline_stage?: unknown; pipeline_status?: unknown; pipeline_reason?: unknown; selection_reasons?: unknown; title?: unknown };

export function hasPassedSalesTestGate(row: SalesTestGateRow): boolean {
  if (row.published !== true) return false;
  if (row.pipeline_status !== "published") return false;
  if (row.pipeline_stage !== "PUBLISHED" && row.pipeline_stage !== "BASE_PUBLISHED") return false;
  if (row.pipeline_reason !== SALES_TEST_GATE_PASSED) return false;
  if (!isJapaneseProductTitle(row.title)) return false;
  return Array.isArray(row.selection_reasons) && row.selection_reasons.includes(SALES_TEST_GATE_PASSED);
}
