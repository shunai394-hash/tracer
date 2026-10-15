import { tracerSkuForListing } from "../shopify/order-sku-mapping.ts";

// Pure Shopify order-line -> shop_listings resolution (no server imports so the
// regression test can load it directly).

export type ShopifyLineIdentity = {
  /** Trimmed line SKU ("" when Shopify sent none). */
  sku: string;
  /** Shopify variant id in both numeric and GID forms (empty when absent). */
  shopifyVariantIds: string[];
};

export type ShopifyListingIdentity = {
  id: string;
  supplier_variant_id?: string | null;
  supplier_product_id?: string | null;
  shopify_variant_id?: string | null;
};

export function shopifyLineIdentity(item: { sku?: unknown; variant_id?: unknown }): ShopifyLineIdentity {
  const sku = typeof item.sku === "string" ? item.sku.trim() : "";
  const raw = item.variant_id == null ? "" : String(item.variant_id).trim();
  const shopifyVariantIds: string[] = [];
  if (raw.startsWith("gid://shopify/ProductVariant/")) {
    shopifyVariantIds.push(raw);
    const numeric = raw.slice("gid://shopify/ProductVariant/".length);
    if (/^\d+$/.test(numeric)) shopifyVariantIds.push(numeric);
  } else if (/^\d+$/.test(raw)) {
    shopifyVariantIds.push(raw, `gid://shopify/ProductVariant/${raw}`);
  }
  return { sku, shopifyVariantIds };
}

export type ShopifyLineResolution<T> =
  | { ok: true; listings: T[] }
  | { ok: false; reason: "listing_mapping_missing" | "listing_mapping_ambiguous"; lineIndex: number; sku: string };

/**
 * Every line must resolve to exactly one listing. Evidence is the exact
 * generated SKU (TRC-<supplier variant | product | listing id>, or a legacy
 * listing UUID) and the Shopify variant id stored at sync time. If the two
 * point at different listings the line is ambiguous and the order stops;
 * nothing is ever guessed from titles or partial matches.
 */
export function resolveShopifyOrderLines<T extends ShopifyListingIdentity>(
  lines: ShopifyLineIdentity[],
  listings: readonly T[],
): ShopifyLineResolution<T> {
  const resolved: T[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const variantIds = new Set(line.shopifyVariantIds);
    const hits = listings.filter((listing) =>
      (line.sku !== "" && (
        tracerSkuForListing(listing) === line.sku
        || listing.id === line.sku
        || (line.sku.startsWith("CJ-") && (
          line.sku === `CJ-${listing.supplier_variant_id || ""}`
          || (!listing.supplier_variant_id && line.sku === `CJ-${listing.supplier_product_id || ""}`)
        ))
      ))
      || (Boolean(listing.shopify_variant_id) && variantIds.has(String(listing.shopify_variant_id))),
    );
    const ids = new Set(hits.map((listing) => listing.id));
    if (ids.size === 0) return { ok: false, reason: "listing_mapping_missing", lineIndex, sku: line.sku };
    if (ids.size > 1) return { ok: false, reason: "listing_mapping_ambiguous", lineIndex, sku: line.sku };
    resolved.push(hits[0]);
  }
  return { ok: true, listings: resolved };
}
