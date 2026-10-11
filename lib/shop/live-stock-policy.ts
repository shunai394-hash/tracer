/** Return true only when a valid Shopify variant has finite, positive live stock. */
export function hasVerifiedPositiveShopifyStock(
  variantId: unknown,
  liveQuantity: unknown,
): boolean {
  if (typeof variantId !== "string" || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) return false;
  return typeof liveQuantity === "number" && Number.isFinite(liveQuantity) && liveQuantity > 0;
}
