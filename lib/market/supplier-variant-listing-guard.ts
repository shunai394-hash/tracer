/**
 * A supplier variant may be represented by only one shop listing at a time.
 * This is a fail-closed guard for both market and supply publication paths;
 * existing duplicate rows are reported as conflicts rather than silently
 * choosing one by response order.
 */
export type SupplierVariantListingRef = { id: string };

export function hasConflictingSupplierVariantListing(
  rows: readonly SupplierVariantListingRef[],
  currentListingId: string | null,
): boolean {
  return rows.some((row) => String(row.id) !== currentListingId);
}
