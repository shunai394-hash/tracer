/**
 * shop_listings.source_cost is the FX-converted selling-currency amount.
 * A real supplier freight quote is stored in that same currency.
 * An estimated allowance used only for pricing stays null, with its own label.
 */
export function persistedListingShippingCost(args: {
  supplierShippingCost: number | null;
  convertedInternationalShipping: number | null;
}): number | null {
  if (args.supplierShippingCost === null || !Number.isFinite(args.supplierShippingCost) || args.supplierShippingCost < 0) return null;
  if (args.convertedInternationalShipping === null || !Number.isFinite(args.convertedInternationalShipping) || args.convertedInternationalShipping < 0) return null;
  return args.convertedInternationalShipping;
}
