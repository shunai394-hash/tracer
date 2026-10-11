export type OrderSkuListing = {
  id: string;
  product_id: string;
  title: string;
  published: boolean;
  orderable: boolean;
  selling_price: number | string | null;
  supplier_listing_id: string | null;
  supplier_name: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
};

export type ShopSkuMappingResult =
  | { ok: true; bySku: Map<string, OrderSkuListing> }
  | { ok: false; reason: "listing_sku_missing" | "listing_mapping_missing" | "listing_mapping_ambiguous" };

/** Resolve Shopify SKUs emitted by sync-published-listings, with safe legacy-ID support. */
export function mapShopifySkusToListings(
  skus: string[],
  listings: OrderSkuListing[],
): ShopSkuMappingResult {
  if (!skus.length || skus.some((sku) => !String(sku ?? "").trim())) {
    return { ok: false, reason: "listing_sku_missing" };
  }

  const wanted = new Set(skus);
  const bySku = new Map<string, OrderSkuListing>();
  const ambiguous = new Set<string>();
  const add = (sku: string, listing: OrderSkuListing) => {
    const existing = bySku.get(sku);
    if (existing && existing.id !== listing.id) {
      ambiguous.add(sku);
      return;
    }
    bySku.set(sku, listing);
  };

  for (const listing of listings) {
    const canonical = `TRC-${String(listing.supplier_variant_id || listing.supplier_product_id || listing.id)}`.slice(0, 100);
    if (wanted.has(canonical)) add(canonical, listing);
    // Older products may have been created with the raw internal listing ID as SKU.
    if (wanted.has(listing.id)) add(listing.id, listing);
  }

  for (const sku of skus) {
    if (ambiguous.has(sku)) return { ok: false, reason: "listing_mapping_ambiguous" };
    if (!bySku.has(sku)) return { ok: false, reason: "listing_mapping_missing" };
  }
  return { ok: true, bySku };
}
