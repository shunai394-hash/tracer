import assert from "node:assert/strict";
import { resolveShopifyOrderLines, shopifyLineIdentity } from "../lib/ordering/shopify-line-match.ts";

const A = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: "2406171151571623500", supplier_product_id: "P-A", shopify_variant_id: "gid://shopify/ProductVariant/46341512069164" };
const B = { id: "22222222-2222-4222-8222-222222222222", supplier_variant_id: "other", supplier_product_id: "P-B", shopify_variant_id: "gid://shopify/ProductVariant/1" };
const listings = [A, B];

// Identity extraction: numeric and GID variant ids, trimmed SKU.
assert.deepEqual(shopifyLineIdentity({ sku: " TRC-2406171151571623500 ", variant_id: 46341512069164 }), { sku: "TRC-2406171151571623500", shopifyVariantIds: ["46341512069164", "gid://shopify/ProductVariant/46341512069164"] });
assert.deepEqual(shopifyLineIdentity({ sku: null, variant_id: "gid://shopify/ProductVariant/7" }).shopifyVariantIds, ["gid://shopify/ProductVariant/7", "7"]);
assert.deepEqual(shopifyLineIdentity({ variant_id: "not-a-variant" }).shopifyVariantIds, []);

const resolve = (items, rows = listings) => resolveShopifyOrderLines(items.map(shopifyLineIdentity), rows);

// SKU and variant id agree.
let r = resolve([{ sku: "TRC-2406171151571623500", variant_id: 46341512069164 }]);
assert.equal(r.ok, true); assert.equal(r.listings[0].id, A.id);
// SKU only, variant id only, legacy listing UUID as SKU.
assert.equal(resolve([{ sku: "TRC-2406171151571623500" }]).listings[0].id, A.id);
assert.equal(resolve([{ sku: "", variant_id: "gid://shopify/ProductVariant/46341512069164" }]).listings[0].id, A.id);
assert.equal(resolve([{ sku: B.id }]).listings[0].id, B.id);
// Generated-SKU fallback to supplier_product_id when no variant id exists.
assert.equal(resolve([{ sku: "TRC-P-C" }], [{ id: "33333333-3333-4333-8333-333333333333", supplier_variant_id: null, supplier_product_id: "P-C" }]).listings[0].id, "33333333-3333-4333-8333-333333333333");
// Missing: unknown SKU, prefix-only guess (CJ-) is not accepted.
r = resolve([{ sku: "TRC-missing" }]);
assert.deepEqual([r.ok, r.reason], [false, "listing_mapping_missing"]);
assert.equal(resolve([{ sku: "CJ-2406171151571623500" }]).reason, "listing_mapping_missing");
// Ambiguous: SKU points to A, Shopify variant id belongs to B.
r = resolve([{ sku: "TRC-2406171151571623500", variant_id: 1 }]);
assert.deepEqual([r.ok, r.reason], [false, "listing_mapping_ambiguous"]);
// Ambiguous: two listings generate the same SKU.
assert.equal(resolve([{ sku: "TRC-2406171151571623500" }], [...listings, { id: "44444444-4444-4444-8444-444444444444", supplier_variant_id: "2406171151571623500", shopify_variant_id: null }]).reason, "listing_mapping_ambiguous");
// Multi-line order: one unresolved line stops the whole order and reports its index.
r = resolve([{ sku: "TRC-2406171151571623500" }, { sku: "TRC-nope" }]);
assert.deepEqual([r.ok, r.reason, r.lineIndex], [false, "listing_mapping_missing", 1]);
assert.deepEqual(resolve([{ sku: "TRC-2406171151571623500" }, { sku: "TRC-other" }]).listings.map((l) => l.id), [A.id, B.id]);

console.log("Shopify line match: SKU, variant id, legacy id, missing, contradictory and multi-line cases passed");
