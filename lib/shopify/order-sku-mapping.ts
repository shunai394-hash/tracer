export type OrderSkuListing = {
  id: string;
  supplier_variant_id?: string | null;
  supplier_product_id?: string | null;
};

export type OrderSkuLookup = {
  supplierSources: string[];
  legacyListingIds: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keep in lockstep with lib/shopify/sync-published-listings.ts. */
export function tracerSkuForListing(listing: OrderSkuListing): string {
  const source = listing.supplier_variant_id || listing.supplier_product_id || listing.id;
  return `TRC-${source}`.slice(0, 100);
}

export function getOrderSkuLookup(skus: string[]): OrderSkuLookup {
  const supplierSources = new Set<string>();
  const legacyListingIds = new Set<string>();
  for (const raw of skus) {
    const sku = raw.trim();
    if (!sku) continue;
    // TRC is the current canonical prefix; CJ is retained for listings
    // created by older supplier-specific publication flows.
    if (sku.startsWith("TRC-") || sku.startsWith("CJ-")) {
      const source = sku.startsWith("TRC-") ? sku.slice(4) : sku.slice(3);
      if (source) supplierSources.add(source);
      // The generated SKU falls back to the listing UUID only when no supplier
      // identity exists. Query UUIDs separately because shop_listings.id is UUID.
      if (UUID.test(source)) legacyListingIds.add(source);
    } else if (UUID.test(sku)) {
      // Backward compatibility for older Shopify variants that used listing.id.
      legacyListingIds.add(sku);
    }
  }
  return { supplierSources: [...supplierSources], legacyListingIds: [...legacyListingIds] };
}

export type OrderSkuResolution =
  | { ok: true; bySku: Map<string, OrderSkuListing> }
  | { ok: false; reason: "listing_mapping_missing" | "listing_mapping_ambiguous"; sku: string };

/** Resolve only exact generated SKU identities; never guess by title or partial match. */
export function resolveShopifyOrderSkus<T extends OrderSkuListing>(
  skus: string[],
  listings: T[],
): { ok: true; bySku: Map<string, T> } | { ok: false; reason: "listing_mapping_missing" | "listing_mapping_ambiguous"; sku: string } {
  const bySku = new Map<string, T>();
  for (const rawSku of skus) {
    const sku = rawSku.trim();
    const exact = listings.filter((listing) =>
      tracerSkuForListing(listing) === sku ||
      (sku.startsWith("CJ-") && Boolean(listing.supplier_variant_id) &&
        `CJ-${listing.supplier_variant_id}` === sku) ||
      listing.id === sku,
    );
    if (exact.length === 0) return { ok: false, reason: "listing_mapping_missing", sku };
    if (exact.length > 1) return { ok: false, reason: "listing_mapping_ambiguous", sku };
    bySku.set(sku, exact[0]);
  }
  return { ok: true, bySku };
}
