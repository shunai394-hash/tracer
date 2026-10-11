import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveShopifyLineItemListings,
  shopifyListingSku,
} from "../lib/shopify/listing-sku.ts";

const variantListing = {
  id: "listing-a",
  supplier_variant_id: "variant-123",
  supplier_product_id: "product-9",
  shopify_variant_id: "gid://shopify/ProductVariant/46342557728812",
};
const productFallback = {
  id: "listing-b",
  supplier_variant_id: null,
  supplier_product_id: "product-456",
  shopify_variant_id: null,
};
const idFallback = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  supplier_variant_id: null,
  supplier_product_id: null,
  shopify_variant_id: null,
};

assert.equal(shopifyListingSku(variantListing), "TRC-variant-123");
const resolved = resolveShopifyLineItemListings(
  [
    { id: 1, sku: "TR-legacy-variant-123", variant_id: "46342557728812" },
    { id: 2, sku: "TRC-product-456", variant_id: null },
    { id: 3, sku: idFallback.id, variant_id: null },
  ],
  [variantListing, productFallback, idFallback],
);
assert.deepEqual(resolved.ambiguousIndices, []);
assert.deepEqual(resolved.missingIndices, []);
assert.deepEqual(resolved.resolved.map((row) => row?.id), [
  "listing-a",
  "listing-b",
  idFallback.id,
]);

// Shopify's immutable variant ID wins even when the live SKU is a supplier-native code.
const variantWins = resolveShopifyLineItemListings(
  [{ sku: "CJYD215009901AZ", variant_id: "gid://shopify/ProductVariant/46342557728812" }],
  [variantListing],
);
assert.equal(variantWins.resolved[0]?.id, "listing-a");

// Legacy SKU formats remain resolvable when they uniquely match supplier identity.
const legacy = resolveShopifyLineItemListings(
  [{ sku: "TR-variant-123", variant_id: null }],
  [variantListing],
);
assert.equal(legacy.resolved[0]?.id, "listing-a");

const ambiguous = resolveShopifyLineItemListings(
  [{ sku: "TRC-duplicate", variant_id: null }],
  [
    { id: "listing-1", supplier_variant_id: "duplicate", supplier_product_id: "product-a", shopify_variant_id: null },
    { id: "listing-2", supplier_variant_id: null, supplier_product_id: "duplicate", shopify_variant_id: null },
  ],
);
assert.equal(ambiguous.resolved[0], null);
assert.deepEqual(ambiguous.ambiguousIndices, [0]);

const missing = resolveShopifyLineItemListings(
  [{ sku: "TRC-not-found", variant_id: null }],
  [variantListing],
);
assert.equal(missing.resolved[0], null);
assert.deepEqual(missing.missingIndices, [0]);

const route = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
assert.match(route, /resolveShopifyLineItemListings/);
assert.match(route, /listing_mapping_ambiguous/);
assert.match(route, /\.in\("shopify_variant_id", variantLookupValues\)/);
assert.match(route, /\.in\("supplier_variant_id", supplierIds\)/);
assert.match(route, /\.in\("supplier_product_id", supplierIds\)/);
console.log("Shopify webhook SKU mapping: variant-first, legacy SKU, missing, ambiguous and route contract checks passed.");
