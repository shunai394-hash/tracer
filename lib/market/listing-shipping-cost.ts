/**
 * shop_listings.source_cost is the FX-converted selling-currency amount.
 * shipping_cost must be that same currency. Persist the converted freight,
 * never the supplier-currency quote sitting next to a JPY cost.
 */
export function persistedListingShippingCost(convertedInternationalShipping: number | null): number | null {
  if (convertedInternationalShipping === null || !Number.isFinite(convertedInternationalShipping) || convertedInternationalShipping < 0) return null;
  return convertedInternationalShipping;
}
