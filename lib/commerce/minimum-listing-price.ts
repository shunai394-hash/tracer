/**
 * Temporary storefront eligibility floor shared by BASE, Shopify, and NEWFIND.
 * This is the public selling price in JPY, not supplier cost or expected profit.
 */
export const MINIMUM_LISTING_PRICE_JPY = 2500;

export function isMinimumListingPriceEligible(value: unknown): boolean {
  const price = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(price) && price >= MINIMUM_LISTING_PRICE_JPY;
}
