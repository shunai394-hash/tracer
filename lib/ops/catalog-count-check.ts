export type CatalogCounts = { shopListings: number; supplierListings: number };
export function catalogCountsNeedReview(current: CatalogCounts, previous: CatalogCounts | null): boolean {
  if (!previous) return false;
  if (previous.shopListings > 0 && current.shopListings === 0) return true;
  return previous.supplierListings >= 1000 && current.supplierListings < previous.supplierListings * 0.5;
}
