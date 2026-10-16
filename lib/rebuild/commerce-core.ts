export type SalesChannel = "base" | "shopify";

export interface SupplierOffer {
  supplierCode: string;
  supplierProductId: string;
  supplierVariantId: string;
  sourceCost: number;
  shippingCost: number;
  stockQuantity: number;
  shipTo: string;
  orderable: boolean;
  trackingAvailable: boolean;
}

export interface PriceInputs {
  sourceCost: number;
  shippingCost: number;
  marketplaceFeeRate: number;
  paymentFeeRate: number;
  targetMarginRate: number;
  roundingUnit?: number;
}

export interface PriceQuote {
  sellingPrice: number;
  estimatedFees: number;
  landedCost: number;
  estimatedProfit: number;
  estimatedMarginRate: number;
}

export function quoteSellingPrice(input: PriceInputs): PriceQuote {
  const values = [input.sourceCost, input.shippingCost, input.marketplaceFeeRate, input.paymentFeeRate, input.targetMarginRate];
  if (!values.every(Number.isFinite) || input.sourceCost < 0 || input.shippingCost < 0 ||
      input.marketplaceFeeRate < 0 || input.paymentFeeRate < 0 ||
      input.targetMarginRate < 0 ||
      input.marketplaceFeeRate + input.paymentFeeRate + input.targetMarginRate >= 1) {
    throw new Error("Invalid price inputs");
  }
  const unit = input.roundingUnit ?? 10;
  if (!Number.isInteger(unit) || unit < 1) throw new Error("roundingUnit must be a positive integer");
  const landedCost = input.sourceCost + input.shippingCost;
  const sellingPrice = Math.ceil((landedCost / (1 - input.marketplaceFeeRate - input.paymentFeeRate - input.targetMarginRate)) / unit) * unit;
  const estimatedFees = sellingPrice * (input.marketplaceFeeRate + input.paymentFeeRate);
  const estimatedProfit = sellingPrice - landedCost - estimatedFees;
  return { sellingPrice, estimatedFees, landedCost, estimatedProfit, estimatedMarginRate: estimatedProfit / sellingPrice };
}

/** Publication is a catalog decision; supplier fulfillment is a separate order-time decision. */
export function canPublishJapaneseCatalogItem(item: {
  titleJa: string;
  descriptionJa?: string | null;
  imageUrls: string[];
  sellingPrice: number;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!item.titleJa.trim()) reasons.push("missing_japanese_title");
  if (!(item.descriptionJa ?? "").trim()) reasons.push("missing_japanese_description");
  if (!item.imageUrls.some((url) => /^https?:\/\//i.test(url))) reasons.push("missing_product_image");
  if (!Number.isFinite(item.sellingPrice) || item.sellingPrice <= 0) reasons.push("invalid_selling_price");
  return { ok: reasons.length === 0, reasons };
}

/** Order execution requires live supplier evidence even when catalog publication is allowed. */
export function canFulfillOffer(offer: SupplierOffer, quantity: number): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!offer.supplierCode.trim()) reasons.push("missing_supplier");
  if (!offer.supplierProductId.trim()) reasons.push("missing_supplier_product_id");
  if (!offer.supplierVariantId.trim()) reasons.push("missing_supplier_variant_id");
  if (!Number.isInteger(quantity) || quantity < 1) reasons.push("invalid_quantity");
  if (!Number.isInteger(offer.stockQuantity) || offer.stockQuantity < quantity) reasons.push("insufficient_stock");
  if (offer.sourceCost < 0 || offer.shippingCost < 0 || !Number.isFinite(offer.sourceCost) || !Number.isFinite(offer.shippingCost)) reasons.push("invalid_supplier_cost");
  if (offer.shipTo !== "JP") reasons.push("supplier_not_shipping_to_japan");
  if (!offer.orderable) reasons.push("supplier_not_orderable");
  if (!offer.trackingAvailable) reasons.push("tracking_unavailable");
  return { ok: reasons.length === 0, reasons };
}

/** Stable webhook key; never infer an internal product ID from an external SKU. */
export function externalOrderKey(channel: SalesChannel, externalOrderId: string): string {
  if (!externalOrderId.trim()) throw new Error("externalOrderId is required");
  return `${channel}:${externalOrderId.trim()}`;
}
