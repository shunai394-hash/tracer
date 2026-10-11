import assert from "node:assert/strict";
import { mapShopifySkusToListings } from "../lib/shopify/order-sku-mapping.ts";

const listing = (overrides = {}) => ({
  id: "listing-1",
  product_id: "product-1",
  title: "日本語の商品",
  published: true,
  orderable: true,
  selling_price: 1980,
  supplier_listing_id: "supplier-listing-1",
  supplier_name: "CJ",
  supplier_product_id: "supplier-product-1",
  supplier_variant_id: "supplier-variant-1",
  ...overrides,
});

let result = mapShopifySkusToListings(["TRC-supplier-variant-1"], [listing()]);
assert.equal(result.ok, true);
if (result.ok) assert.equal(result.bySku.get("TRC-supplier-variant-1")?.id, "listing-1");

result = mapShopifySkusToListings(["TRC-supplier-product-1"], [listing({ supplier_variant_id: null })]);
assert.equal(result.ok, true);
if (result.ok) assert.equal(result.bySku.get("TRC-supplier-product-1")?.id, "listing-1");

result = mapShopifySkusToListings(["TRC-listing-1"], [listing({ supplier_variant_id: null, supplier_product_id: null })]);
assert.equal(result.ok, true);
if (result.ok) assert.equal(result.bySku.get("TRC-listing-1")?.id, "listing-1");

result = mapShopifySkusToListings(["listing-1"], [listing()]);
assert.equal(result.ok, true, "legacy raw listing-ID SKUs remain supported");

result = mapShopifySkusToListings(["TRC-not-found"], [listing()]);
assert.deepEqual(result, { ok: false, reason: "listing_mapping_missing" });

result = mapShopifySkusToListings([""], [listing()]);
assert.deepEqual(result, { ok: false, reason: "listing_sku_missing" });

result = mapShopifySkusToListings(["TRC-duplicate-variant"], [
  listing({ id: "listing-a", supplier_variant_id: "duplicate-variant" }),
  listing({ id: "listing-b", supplier_variant_id: "duplicate-variant" }),
]);
assert.deepEqual(result, { ok: false, reason: "listing_mapping_ambiguous" });

result = mapShopifySkusToListings(["TRC-supplier-variant-1", "TRC-supplier-variant-1"], [listing()]);
assert.equal(result.ok, true, "repeated line items for the same listing should resolve consistently");

console.log("Shopify webhook SKU mapping: 8 assertions passed");
