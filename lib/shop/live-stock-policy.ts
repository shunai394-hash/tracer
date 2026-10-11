/** Return true only when a Shopify variant has a finite, positive live quantity. */
export function hasVerifiedPositiveShopifyStock(
  variantId: unknown,
  liveQuantity: unknown,
): boolean {
  if (typeof variantId !== "string" || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) {
    return false;
  }
  return typeof liveQuantity === "number" &&
    Number.isFinite(liveQuantity) &&
    liveQuantity > 0;
}
