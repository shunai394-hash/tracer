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
  if (!input.identityLinked || input.identityMethod === "title") reasons.push("identity_not_confirmed");
  if (input.identityConfidence !== undefined && (input.identityConfidence === null || !Number.isFinite(input.identityConfidence) || input.identityConfidence < 0.88)) reasons.push("identity_confidence_low");
  if (input.sourceCost === null) reasons.push("source_cost_unknown");
  else if (!Number.isFinite(input.sourceCost) || input.sourceCost < 0) reasons.push("source_cost_invalid");
  if (input.shippingCost === null || input.shippingUnknown) reasons.push("shipping_unknown");
  else if (!Number.isFinite(input.shippingCost) || input.shippingCost < 0) reasons.push("shipping_invalid");
  if (input.trackingAvailable !== true) reasons.push("tracking_unknown");
  if (input.apiAvailable !== true) reasons.push("supplier_api_unknown");
  if (!input.profitCalculable || input.currencyMismatch) reasons.push("profit_unknown");
  if (input.contributionProfit === null || !Number.isFinite(input.contributionProfit) || input.contributionProfit <= 0) reasons.push("profit_not_positive");
  if (input.priceConfirmed !== undefined && input.priceConfirmed !== true) reasons.push("price_unconfirmed");
  if (input.inventoryConfirmed !== undefined && input.inventoryConfirmed !== true) reasons.push("inventory_unknown");
  if (input.inventory !== undefined && (input.inventory === null || !Number.isFinite(input.inventory) || input.inventory <= 0)) reasons.push("inventory_zero");
  if (input.orderable !== undefined && input.orderable !== true) reasons.push("supplier_not_orderable");
  if (input.supplierProductId !== undefined && !input.supplierProductId) reasons.push("supplier_product_unknown");
  if (input.supplierVariantId !== undefined && !input.supplierVariantId) reasons.push("supplier_variant_unknown");
  return { eligible: reasons.length === 0, reasons };
}

export function verifySalesTestGateInvariants(): { ok: boolean; cases: Array<{ name: string; expected: boolean; actual: boolean }> } {
  const ready = evaluateSalesTestGate({ rank: 1, title: "床用フロアマット", sellingPrice: 3980, identityLinked: true, identityMethod: "jan", sourceCost: 12, shippingCost: 4, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 8, currencyMismatch: false });
  const englishTitle = evaluateSalesTestGate({ rank: 1, title: "Floor Mat", sellingPrice: 3980, identityLinked: false, identityMethod: "title", sourceCost: 12, shippingCost: 4, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 8, currencyMismatch: false });
  const supplyReady = evaluateSalesTestGate({ ...supplyReadyInput(), requireRank: false });
  const supplyInventoryBlocked = evaluateSalesTestGate({ ...supplyReadyInput(), inventory: 0, requireRank: false });
  const invalidPrice = evaluateSalesTestGate({ ...supplyReadyInput(), sellingPrice: 0, requireRank: false });
  const invalidEconomics = evaluateSalesTestGate({ ...supplyReadyInput(), sourceCost: -1, shippingCost: -1, requireRank: false });
  const giftCard = evaluateSalesTestGate({ ...supplyReadyInput(), title: "Amazonギフトカード", requireRank: false });
  const unknownProfit = evaluateSalesTestGate({ ...supplyReadyInput(), contributionProfit: null, requireRank: false });
  const cases = [
    { name: "complete_observed_product_is_eligible", expected: true, actual: ready.eligible },
    { name: "english_title_is_not_eligible", expected: true, actual: englishTitle.eligible === false && englishTitle.reasons.includes("japanese_title_required") },
    { name: "supply_ready_is_eligible_without_market_rank", expected: true, actual: supplyReady.eligible },
    { name: "supply_zero_inventory_is_blocked", expected: true, actual: supplyInventoryBlocked.eligible === false && supplyInventoryBlocked.reasons.includes("inventory_zero") },
    { name: "zero_price_is_blocked", expected: true, actual: invalidPrice.eligible === false && invalidPrice.reasons.includes("selling_price_invalid") },
    { name: "negative_economics_are_blocked", expected: true, actual: invalidEconomics.eligible === false && invalidEconomics.reasons.includes("source_cost_invalid") && invalidEconomics.reasons.includes("shipping_invalid") },
    { name: "gift_card_is_blocked", expected: true, actual: giftCard.eligible === false && giftCard.reasons.includes("non_physical_product") },
    { name: "unknown_contribution_profit_is_blocked", expected: true, actual: unknownProfit.eligible === false && unknownProfit.reasons.includes("profit_not_positive") },
    {
      name: "market_alias_reason_still_counts_as_the_same_pass",
      expected: true,
      actual: hasPassedSalesTestGate({ published: true, pipeline_stage: "PUBLISHED", pipeline_status: "published", pipeline_reason: SALES_TEST_GATE_MARKET_ALIAS, title: "床用フロアマット", selection_reasons: [SALES_TEST_GATE_PASSED] }),
    },
    {
      name: "unrelated_pipeline_reason_does_not_pass",
      expected: true,
      actual: hasPassedSalesTestGate({ published: true, pipeline_stage: "PUBLISHED", pipeline_status: "published", pipeline_reason: "base_item_exists", title: "床用フロアマット", selection_reasons: [SALES_TEST_GATE_PASSED] }) === false,
    },
    {
      name: "remote_item_id_cannot_publish_without_the_gate",
      expected: true,
      actual: channelVisibilityForSalesGate("base-item-1", false) === "hide" && channelVisibilityForSalesGate(null, false) === "skip" && channelVisibilityForSalesGate("base-item-1", true) === "publish",
    },
    {
      name: "inventory_hold_can_restore_visibility_other_blocks_cannot",
      expected: true,
      actual: mayRestoreChannelVisibility({ published: true, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "inventory_zero", title: "床用フロアマット", selection_reasons: [SALES_TEST_GATE_PASSED] })
        && mayRestoreChannelVisibility({ published: true, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "tracking_unavailable", title: "床用フロアマット", selection_reasons: [SALES_TEST_GATE_PASSED] }) === false,
    },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}

function supplyReadyInput(): SalesTestGateInput {
  return { rank: null, title: "検証用サプライ商品", sellingPrice: 3980, identityLinked: true, identityMethod: "jan", identityConfidence: 0.95, sourceCost: 1000, shippingCost: 300, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 2680, currencyMismatch: false, priceConfirmed: true, inventoryConfirmed: true, inventory: 20, orderable: true, supplierProductId: "pid", supplierVariantId: "vid" };
}

export const SALES_TEST_GATE_PASSED = "sales_test_gate_passed";

/**
 * Historical shop_listings.pipeline_reason written by the market selector
 * for rows that also stored SALES_TEST_GATE_PASSED in selection_reasons.
 * New writes use SALES_TEST_GATE_PASSED. The alias is not a separate pass.
 */
export const SALES_TEST_GATE_MARKET_ALIAS = "sales_test_gate_passed_canonical_publish";

const INVENTORY_RECOVERY_REASONS = new Set([
  "inventory_zero",
  "inventory_unknown",
  "supplier_not_orderable",
]);

export type SalesTestGateRow = { published?: unknown; pipeline_stage?: unknown; pipeline_status?: unknown; pipeline_reason?: unknown; selection_reasons?: unknown; title?: unknown };

function reasonRecordsSalesTestPass(reason: unknown): boolean {
  return reason === SALES_TEST_GATE_PASSED || reason === SALES_TEST_GATE_MARKET_ALIAS;
}

export function hasPassedSalesTestGate(row: SalesTestGateRow): boolean {
  if (row.published !== true) return false;
  if (row.pipeline_status !== "published") return false;
  if (row.pipeline_stage !== "PUBLISHED" && row.pipeline_stage !== "BASE_PUBLISHED") return false;
  if (!reasonRecordsSalesTestPass(row.pipeline_reason)) return false;
  if (!isJapaneseProductTitle(row.title)) return false;
  return Array.isArray(row.selection_reasons) && row.selection_reasons.includes(SALES_TEST_GATE_PASSED);
}

/**
 * Stock recovery may show an existing channel item again only when the
 * durable sales-test token is still present and the pipeline hold is an
 * inventory hold. A remote item id alone is not permission to sell.
 */
export function mayRestoreChannelVisibility(row: SalesTestGateRow): boolean {
  if (hasPassedSalesTestGate(row)) return true;
  return row.published === true
    && isJapaneseProductTitle(row.title)
    && Array.isArray(row.selection_reasons)
    && row.selection_reasons.includes(SALES_TEST_GATE_PASSED)
    && INVENTORY_RECOVERY_REASONS.has(String(row.pipeline_reason ?? ""));
}

/** An existing remote item id never authorizes a visible update by itself. */
export function channelVisibilityForSalesGate(remoteItemId: string | null, gatePassed: boolean): "publish" | "hide" | "skip" {
  if (gatePassed) return "publish";
  return remoteItemId ? "hide" : "skip";
}
