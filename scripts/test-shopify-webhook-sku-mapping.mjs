import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveShopifySkuListings, shopifyListingSku } from "../lib/shopify/listing-sku.ts";

const variantListing = { id: "listing-a", supplier_variant_id: "variant-123", supplier_product_id: "product-9" };
const productFallback = { id: "listing-b", supplier_variant_id: null, supplier_product_id: "product-456" };
const idFallback = { id: "123e4567-e89b-12d3-a456-426614174000", supplier_variant_id: null, supplier_product_id: null };

assert.equal(shopifyListingSku(variantListing), "TRC-variant-123");
assert.equal(shopifyListingSku(productFallback), "TRC-product-456");
assert.equal(shopifyListingSku(idFallback), `TRC-${idFallback.id}`);

const resolved = resolveShopifySkuListings(
  ["TRC-variant-123", "TRC-product-456", `TRC-${idFallback.id}`],
  [variantListing, productFallback, idFallback],
);
assert.equal(resolved.bySku.get("TRC-variant-123")?.id, "listing-a");
assert.equal(resolved.bySku.get("TRC-product-456")?.id, "listing-b");
assert.equal(resolved.bySku.get(`TRC-${idFallback.id}`)?.id, idFallback.id);
assert.deepEqual(resolved.ambiguous, []);

const legacyRawId = resolveShopifySkuListings([idFallback.id], [idFallback]);
assert.equal(legacyRawId.bySku.get(idFallback.id)?.id, idFallback.id);

const ambiguous = resolveShopifySkuListings(
  ["TRC-duplicate"],
  [
    { id: "listing-1", supplier_variant_id: "duplicate", supplier_product_id: "product-a" },
    { id: "listing-2", supplier_variant_id: null, supplier_product_id: "duplicate" },
  ],
);
assert.equal(ambiguous.bySku.has("TRC-duplicate"), false);
assert.deepEqual(ambiguous.ambiguous, ["TRC-duplicate"]);

const missing = resolveShopifySkuListings(["TRC-not-found"], [variantListing]);
assert.equal(missing.bySku.has("TRC-not-found"), false);
assert.deepEqual(missing.ambiguous, []);

const route = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
assert.match(route, /resolveShopifySkuListings/);
assert.match(route, /shopify_sku_mapping_ambiguous|listing_mapping_ambiguous/);
assert.match(route, /\.in\("supplier_variant_id", supplierIds\)/);
assert.match(route, /\.in\("supplier_product_id", supplierIds\)/);
console.log("Shopify webhook SKU mapping: 8 mapping assertions + 4 route-contract assertions passed.");
