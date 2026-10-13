import { isJapaneseProductDescription, isJapaneseProductTitle } from "../intelligence/japanese-product.ts";
import { cjSellabilityBlockReasons, isClosedSupplierFulfillment } from "../procurement/cj-fulfillment-gate.ts";

export type ChannelListingEligibilityInput = {
  title: unknown;
  description: unknown;
  imageUrl: unknown;
  /** true only after a successful image response. null means the fetch was not performed. */
  imageReachable: boolean | null;
  sellingPrice: unknown;
  currency: unknown;
  sourceCost: unknown;
  shippingCost: unknown;
  contributionProfit: unknown;
  profitCalculable: boolean;
  currencyMismatch: boolean;
  inventory: unknown;
  inventoryConfirmed: boolean | null;
  orderable: boolean | null;
  trackingAvailable: boolean | null;
  supplierProductId: unknown;
  supplierVariantId: unknown;
  identityLinked: boolean;
  identityMethod: unknown;
  identityConfidence: unknown;
  salesTestPassed: boolean;
  /** Selectors create the sales-test token; storefront sync must require it. */
  requireSalesTestPass?: boolean;
  supplierName: unknown;
  supplierAdapterRegistered: boolean;
};

/**
 * Conservative listing ceiling: exceptionally large counts require a fresh
 * supplier-side reconciliation instead of being copied to storefront inventory.
 * This is a safety stop, not a claim that suppliers cannot hold more stock.
 */
export const MAX_LISTABLE_INVENTORY_WITHOUT_MANUAL_RECHECK = 1000;

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function trimmedSupplierId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

export function isHttpImageUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function evaluateChannelListingEligibility(input: ChannelListingEligibilityInput): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.requireSalesTestPass !== false && !input.salesTestPassed) reasons.push("sales_test_gate_not_passed");
  if (!isJapaneseProductTitle(input.title)) reasons.push("japanese_title_required");
  if (!isJapaneseProductDescription(input.description)) reasons.push("japanese_description_required");
  if (!isHttpImageUrl(input.imageUrl)) reasons.push("image_url_invalid");
  else if (input.imageReachable === false) reasons.push("image_fetch_failed");
  else if (input.imageReachable !== true) reasons.push("image_not_confirmed");

  const price = finite(input.sellingPrice);
  if (price === null || price <= 0) reasons.push("selling_price_invalid");
  if (String(input.currency ?? "").trim().toUpperCase() !== "JPY") reasons.push("currency_not_jpy");

  const sourceCost = finite(input.sourceCost);
  if (sourceCost === null || sourceCost < 0) reasons.push("source_cost_unknown");
  const shippingCost = finite(input.shippingCost);
  if (shippingCost === null || shippingCost < 0) reasons.push("shipping_unknown");
  if (!input.profitCalculable || input.currencyMismatch) reasons.push("profit_unknown");
  const profit = finite(input.contributionProfit);
  if (profit === null || profit <= 0) reasons.push("profit_not_positive");

  if (input.inventoryConfirmed !== true) reasons.push("inventory_unconfirmed");
  const inventory = finite(input.inventory);
  if (inventory === null || inventory <= 0) reasons.push("inventory_zero_or_unknown");
  else if (inventory > MAX_LISTABLE_INVENTORY_WITHOUT_MANUAL_RECHECK) reasons.push("inventory_outlier_requires_recheck");
  if (input.orderable !== true) reasons.push("supplier_not_orderable");
  if (input.trackingAvailable !== true) reasons.push("tracking_unavailable");
  if (!trimmedSupplierId(input.supplierProductId)) reasons.push("supplier_product_unknown");
  if (!trimmedSupplierId(input.supplierVariantId)) reasons.push("supplier_variant_unknown");
  const identityMethod = typeof input.identityMethod === "string" ? input.identityMethod.trim().toLowerCase() : "";
  const identifierGrade = new Set(["asin", "jan", "gtin", "ean", "upc", "mpn", "brand_mpn", "tracer_catalog"]);
  if (!input.identityLinked || !identifierGrade.has(identityMethod)) reasons.push("identity_not_confirmed");
  const confidence = finite(input.identityConfidence);
  if (confidence === null || confidence < 0.88) reasons.push("identity_confidence_low");

  if (isClosedSupplierFulfillment(input.supplierName)) {
    reasons.push(...cjSellabilityBlockReasons({ adapterRegistered: input.supplierAdapterRegistered }));
  } else if (!input.supplierAdapterRegistered) {
    reasons.push("supplier_adapter_not_registered");
  }

  return { eligible: reasons.length === 0, reasons: Array.from(new Set(reasons)) };
}

/**
 * Inventory refresh may change channel visibility. A positive stock count is
 * not permission to sell: the same publication gate decides both flags.
 */
export function decideInventoryRefreshVisibility(input: ChannelListingEligibilityInput): { orderable: boolean; visible: boolean; reasons: string[] } {
  const decision = evaluateChannelListingEligibility(input);
  return { orderable: decision.eligible, visible: decision.eligible, reasons: decision.reasons };
}
