import test from "node:test";
import assert from "node:assert/strict";
import {
  getOrderSkuLookup,
  resolveShopifyOrderSkus,
  tracerSkuForListing,
} from "../lib/shopify/order-sku-mapping.ts";

test("resolves generated TRC SKU by supplier variant ID", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: "variant-42", supplier_product_id: "product-7" };
  const sku = tracerSkuForListing(listing);
  assert.equal(sku, "TRC-variant-42");
  assert.deepEqual(getOrderSkuLookup([sku]).supplierSources, ["variant-42"]);
  const resolved = resolveShopifyOrderSkus([sku], [listing]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.bySku.get(sku)?.id, listing.id);
});

test("resolves SKU fallback to supplier product ID", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: null, supplier_product_id: "product-7" };
  const sku = tracerSkuForListing(listing);
  assert.equal(sku, "TRC-product-7");
  const resolved = resolveShopifyOrderSkus([sku], [listing]);
  assert.equal(resolved.ok, true);
});

test("resolves SKU fallback to listing ID and supports legacy raw listing ID", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: null, supplier_product_id: null };
  const generated = tracerSkuForListing(listing);
  assert.deepEqual(getOrderSkuLookup([generated]).legacyListingIds, [listing.id]);
  assert.equal(resolveShopifyOrderSkus([generated], [listing]).ok, true);
  assert.equal(resolveShopifyOrderSkus([listing.id], [listing]).ok, true);
});

test("fails closed for missing and ambiguous exact SKU mappings", () => {
  assert.deepEqual(
    resolveShopifyOrderSkus(["TRC-no-match"], []),
    { ok: false, reason: "listing_mapping_missing", sku: "TRC-no-match" },
  );
  const a = { id: "a", supplier_variant_id: "same-variant", supplier_product_id: null };
  const b = { id: "b", supplier_variant_id: "same-variant", supplier_product_id: null };
  assert.deepEqual(
    resolveShopifyOrderSkus(["TRC-same-variant"], [a, b]),
    { ok: false, reason: "listing_mapping_ambiguous", sku: "TRC-same-variant" },
  );
});
