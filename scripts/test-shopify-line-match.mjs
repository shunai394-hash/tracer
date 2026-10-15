import assert from "node:assert/strict";
import { matchShopifyLineToListing, shopifyLineLookup } from "../lib/ordering/shopify-line-match.ts";

const lookup = shopifyLineLookup({ sku: "TRC-2406171151571623500", variantId: 46341512069164 });
assert.equal(lookup.listingId, null);
assert.equal(lookup.supplierVariantId, "2406171151571623500");
assert.deepEqual(lookup.shopifyVariantIds, ["46341512069164", "gid://shopify/ProductVariant/46341512069164"]);

const listings = [
  { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: "2406171151571623500", shopify_variant_id: "gid://shopify/ProductVariant/46341512069164" },
  { id: "22222222-2222-4222-8222-222222222222", supplier_variant_id: "other", shopify_variant_id: "gid://shopify/ProductVariant/1" },
];

const matched = matchShopifyLineToListing(lookup, listings);
assert.equal(matched.reason, "matched");
assert.equal(matched.listing?.id, listings[0].id);

const byShopifyId = matchShopifyLineToListing(shopifyLineLookup({ sku: "", variantId: "gid://shopify/ProductVariant/46341512069164" }), listings);
assert.equal(byShopifyId.listing?.id, listings[0].id);

const byListingId = matchShopifyLineToListing(shopifyLineLookup({ sku: listings[1].id }), listings);
assert.equal(byListingId.listing?.id, listings[1].id);

assert.equal(matchShopifyLineToListing(shopifyLineLookup({ sku: "CJ-missing" }), listings).reason, "listing_mapping_missing");
assert.equal(matchShopifyLineToListing(shopifyLineLookup({ sku: "TRC-2406171151571623500" }), [
  ...listings,
  { id: "33333333-3333-4333-8333-333333333333", supplier_variant_id: "2406171151571623500", shopify_variant_id: null },
]).reason, "listing_mapping_ambiguous");

console.log("Shopify line match: supplier variant, variant id, and ambiguous cases passed");
