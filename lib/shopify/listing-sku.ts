export type ShopifySkuListing = {
  id: string;
  supplier_variant_id?: string | null;
  supplier_product_id?: string | null;
  shopify_variant_id?: string | null;
};

export type ShopifyOrderLineItemIdentity = {
  id?: string | number | null;
  sku?: string | null;
  variant_id?: string | number | null;
};

function normalizeShopifyId(value: unknown): string {
  return String(value ?? "").trim().split("/").filter(Boolean).at(-1) ?? "";
}

export function shopifyListingSku(listing: ShopifySkuListing): string {
  const source = listing.supplier_variant_id || listing.supplier_product_id || listing.id;
  return `TRC-${source}`.slice(0, 100);
}

function skuAliases(listing: ShopifySkuListing): string[] {
  const source = listing.supplier_variant_id || listing.supplier_product_id || listing.id;
  return [...new Set([
    shopifyListingSku(listing),
    `TR-${source}`.slice(0, 100),
    String(source),
    listing.id,
  ])];
}

export function resolveShopifyLineItemListings<T extends ShopifySkuListing>(
  items: ShopifyOrderLineItemIdentity[],
  listings: T[],
): { resolved: Array<T | null>; ambiguousIndices: number[]; missingIndices: number[] } {
  const resolved: Array<T | null> = [];
  const ambiguousIndices: number[] = [];
  const missingIndices: number[] = [];

  items.forEach((item, index) => {
    const variantId = normalizeShopifyId(item.variant_id);
    const variantMatches = variantId
      ? listings.filter((listing) => normalizeShopifyId(listing.shopify_variant_id) === variantId)
      : [];

    if (variantMatches.length > 1) {
      resolved.push(null);
      ambiguousIndices.push(index);
      return;
    }
    if (variantMatches.length === 1) {
      resolved.push(variantMatches[0]);
      return;
    }

    const sku = String(item.sku ?? "").trim();
    const skuMatches = sku
      ? listings.filter((listing) => skuAliases(listing).includes(sku))
      : [];

    if (skuMatches.length > 1) {
      resolved.push(null);
      ambiguousIndices.push(index);
      return;
    }
    if (skuMatches.length === 1) {
      resolved.push(skuMatches[0]);
      return;
    }

    resolved.push(null);
    missingIndices.push(index);
  });

  return { resolved, ambiguousIndices, missingIndices };
}
