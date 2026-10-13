export type CjSupplyWriteDecision = {
  writeSalesOffer: boolean;
  orderable: boolean;
  trackingAvailable: boolean;
  priceConfirmed: boolean;
  inventoryConfirmed: boolean;
  apiAvailable: boolean;
  verificationStatus: "unverified";
  reasons: string[];
};

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/**
 * A CJ catalog observation is not a sales offer. Identity must be unique, and
 * orderability is never inferred from a stock count. Tracking is false unless
 * a live tracking response was observed; discovery does not have one.
 * Order, payment, and tracking sync are not connected, so orderable stays false.
 */
export function decideCjSupplyWrite(args: {
  supplierProductId: unknown;
  supplierVariantId: unknown;
  observedVariantId?: unknown;
  identityConfirmed: boolean;
  inventory: unknown;
  cost: unknown;
  shippingCost: unknown;
  trackingObserved?: boolean | null;
}): CjSupplyWriteDecision {
  const reasons: string[] = [];
  const supplierProductId = trimmed(args.supplierProductId);
  const supplierVariantId = trimmed(args.supplierVariantId);
  const observedVariantId = trimmed(args.observedVariantId);
  if (!supplierProductId) reasons.push("supplier_product_unknown");
  if (!supplierVariantId) reasons.push("supplier_variant_unknown");
  if (observedVariantId && supplierVariantId && observedVariantId !== supplierVariantId) {
    reasons.push("supplier_variant_mismatch");
  }
  if (!args.identityConfirmed) reasons.push("identity_not_confirmed");

  const inventory = finite(args.inventory);
  const inventoryConfirmed = inventory !== null && inventory >= 0;
  if (!inventoryConfirmed) reasons.push("inventory_unknown");
  else if (inventory <= 0) reasons.push("inventory_zero");

  const cost = finite(args.cost);
  const priceConfirmed = cost !== null && cost > 0;
  if (!priceConfirmed) reasons.push("price_unconfirmed");

  const shipping = finite(args.shippingCost);
  if (shipping === null || shipping < 0) reasons.push("shipping_unknown");

  const trackingAvailable = args.trackingObserved === true;
  if (!trackingAvailable) reasons.push("tracking_unavailable");

  reasons.push("cj_order_api_not_connected", "cj_payment_confirmation_not_connected", "cj_tracking_sync_not_connected");

  return {
    writeSalesOffer: reasons.length === 0,
    orderable: false,
    trackingAvailable,
    priceConfirmed,
    inventoryConfirmed,
    apiAvailable: false,
    verificationStatus: "unverified",
    reasons,
  };
}
