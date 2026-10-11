export type ShopifySkuListing = {
  id: string;
  supplier_variant_id?: string | null;
  supplier_product_id?: string | null;
};

export function shopifyListingSku(listing: ShopifySkuListing): string {
  const source = listing.supplier_variant_id || listing.supplier_product_id || listing.id;
  return `TRC-${source}`.slice(0, 100);
}

export function resolveShopifySkuListings<T extends ShopifySkuListing>(
  skus: string[],
  listings: T[],
): { bySku: Map<string, T>; ambiguous: string[] } {
  const bySku = new Map<string, T>();
  const ambiguous: string[] = [];

  for (const sku of new Set(skus)) {
    const matches = listings.filter((listing) => listing.id === sku || shopifyListingSku(listing) === sku);
    if (matches.length > 1) {
      ambiguous.push(sku);
      continue;
    }
    if (matches.length === 1) bySku.set(sku, matches[0]);
  }

  return { bySku, ambiguous };
}
