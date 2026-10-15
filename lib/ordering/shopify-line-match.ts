const LISTING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ShopifyLineLookup = {
  listingId: string | null;
  supplierVariantId: string | null;
  shopifyVariantIds: string[];
};

export function shopifyLineLookup(input: { sku?: unknown; variantId?: unknown }): ShopifyLineLookup {
  const sku = typeof input.sku === "string" ? input.sku.trim() : "";
  const listingId = LISTING_UUID.test(sku) ? sku : null;
  const prefixed = /^(?:TRC|CJ)-(.+)$/i.exec(sku);
  const supplierVariantId = prefixed?.[1]?.trim() ? prefixed[1].trim() : null;
  const rawVariant = input.variantId == null ? "" : String(input.variantId).trim();
  const shopifyVariantIds: string[] = [];
  if (rawVariant.startsWith("gid://shopify/ProductVariant/")) {
    shopifyVariantIds.push(rawVariant);
    const numeric = rawVariant.slice("gid://shopify/ProductVariant/".length);
    if (/^\d+$/.test(numeric)) shopifyVariantIds.push(numeric);
  } else if (/^\d+$/.test(rawVariant)) {
    shopifyVariantIds.push(rawVariant, `gid://shopify/ProductVariant/${rawVariant}`);
  }
  return { listingId, supplierVariantId, shopifyVariantIds };
}

export type ShopifyListingIdentity = {
  id: string;
  supplier_variant_id?: string | null;
  shopify_variant_id?: string | null;
};

export function matchShopifyLineToListing<T extends ShopifyListingIdentity>(
  line: ShopifyLineLookup,
  listings: readonly T[],
): { listing: T | null; reason: "matched" | "listing_mapping_missing" | "listing_mapping_ambiguous" } {
  const variantIds = new Set(line.shopifyVariantIds);
  const hits = listings.filter((row) => {
    if (line.listingId && row.id === line.listingId) return true;
    if (line.supplierVariantId && row.supplier_variant_id && row.supplier_variant_id === line.supplierVariantId) return true;
    if (row.shopify_variant_id && variantIds.has(String(row.shopify_variant_id))) return true;
    return false;
  });
  const ids = new Set(hits.map((row) => row.id));
  if (ids.size === 1) return { listing: hits[0], reason: "matched" };
  if (ids.size === 0) return { listing: null, reason: "listing_mapping_missing" };
  return { listing: null, reason: "listing_mapping_ambiguous" };
}
