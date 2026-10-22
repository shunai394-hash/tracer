import assert from "node:assert/strict";
import test from "node:test";
import { resolveShopifyVariantIdentity } from "../lib/shopify/variant-identity.ts";

const red = { id: "gid://shopify/ProductVariant/101", sku: "TRC-red", price: "1886" };
const blue = { id: "gid://shopify/ProductVariant/102", sku: "TRC-blue", price: "1886" };

test("saved variant ID and SKU corroborate the same color variant", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([red, blue], "TRC-red", red.id), {
    ok: true, variant: red, matchedBy: "saved_id",
  });
});

test("refuses to update a saved variant whose SKU identifies another color", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([red, blue], "TRC-blue", red.id), {
    ok: false, reason: "saved_variant_sku_mismatch",
  });
});

test("uses the saved variant ID to safely repair a missing SKU on that exact variant", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([{ id: red.id, sku: null }], "TRC-red", red.id), {
    ok: true, variant: { id: red.id, sku: null }, matchedBy: "saved_id",
  });
  assert.deepEqual(resolveShopifyVariantIdentity([{ id: red.id, sku: "  " }], "TRC-red", red.id), {
    ok: true, variant: { id: red.id, sku: "  " }, matchedBy: "saved_id",
  });
});

test("refuses to resolve a variant without an expected SKU", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([red], "  ", red.id), {
    ok: false, reason: "expected_sku_missing",
  });
});

test("uses only a unique exact SKU when the saved variant ID is absent", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([red, blue], "TRC-blue"), {
    ok: true, variant: blue, matchedBy: "exact_sku",
  });
});

test("fails closed for duplicate SKU and ambiguous multi-variant products", () => {
  assert.equal(resolveShopifyVariantIdentity([red, { ...blue, id: "gid://shopify/ProductVariant/103", sku: "TRC-red" }], "TRC-red").ok, false);
  assert.deepEqual(resolveShopifyVariantIdentity([red, blue], "TRC-missing"), {
    ok: false, reason: "variant_identity_ambiguous",
  });
});

test("permits a single legacy variant when no saved ID or exact SKU exists", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([{ id: "gid://shopify/ProductVariant/104", sku: "legacy" }], "TRC-new"), {
    ok: true,
    variant: { id: "gid://shopify/ProductVariant/104", sku: "legacy" },
    matchedBy: "single_variant",
  });
});
