export type StorefrontStockDecision =
  | { visible: true; inventory: number }
  | { visible: false; reason: "live_stock_unavailable" | "shopify_variant_unknown" | "live_stock_unknown" | "live_stock_zero" | "db_inventory_zero" };

/** Return true only when a valid Shopify variant has finite, positive live stock. */
export function hasVerifiedPositiveShopifyStock(
  variantId: unknown,
  liveQuantity: unknown,
): boolean {
  if (typeof variantId !== "string" || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) return false;
  return typeof liveQuantity === "number" && Number.isFinite(liveQuantity) && liveQuantity > 0;
}

/**
 * Storefront orderability when Shopify is the stock authority.
 * A failed or missing live quantity is not treated as in stock.
 * When Shopify is not configured, the already-filtered database quantity remains the only signal.
 */
export function decideStorefrontStock(args: {
  shopifyConfigured: boolean;
  liveCheckFailed: boolean;
  shopifyVariantId: string | null;
  dbInventory: number;
  liveQuantity: number | undefined;
}): StorefrontStockDecision {
  if (!args.shopifyConfigured) {
    return args.dbInventory > 0
      ? { visible: true, inventory: args.dbInventory }
      : { visible: false, reason: "db_inventory_zero" };
  }
  if (args.liveCheckFailed) return { visible: false, reason: "live_stock_unavailable" };
  if (!args.shopifyVariantId || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(args.shopifyVariantId)) {
    return { visible: false, reason: "shopify_variant_unknown" };
  }
  if (args.liveQuantity === undefined) return { visible: false, reason: "live_stock_unknown" };
  if (!hasVerifiedPositiveShopifyStock(args.shopifyVariantId, args.liveQuantity)) {
    return { visible: false, reason: "live_stock_zero" };
  }
  return { visible: true, inventory: Math.floor(args.liveQuantity) };
}
