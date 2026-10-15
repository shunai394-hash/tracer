/** Store supplier freight in the same selling currency as the converted source cost. */
export function persistedListingShippingCost(args: { supplierShippingCost: number | null; convertedInternationalShipping: number | null }): number | null {
  if (args.supplierShippingCost === null || !Number.isFinite(args.supplierShippingCost) || args.supplierShippingCost < 0) return null;
  if (args.convertedInternationalShipping === null || !Number.isFinite(args.convertedInternationalShipping) || args.convertedInternationalShipping < 0) return null;
  return args.convertedInternationalShipping;
}
