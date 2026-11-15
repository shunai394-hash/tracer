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

test("recovers to the unique exact-SKU variant when a saved ID points to another color", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([red, blue], "TRC-blue", red.id), {
    ok: true, variant: blue, matchedBy: "exact_sku",
  });
});

test("fails closed when a saved variant SKU differs in a multi-variant product and no exact SKU match exists", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([red, { ...blue, sku: "TRC-other" }], "TRC-blue", red.id), {
    ok: false, reason: "saved_variant_sku_mismatch",
  });
});

test("allows SKU repair when the saved ID is the only variant in the exact Shopify product", () => {
  const legacy = { id: "gid://shopify/ProductVariant/105", sku: "TRC-bae83f35-78d0-4a7e-a556-03127bdaf9db" };
  assert.deepEqual(resolveShopifyVariantIdentity([legacy], "TRC-AF3718DF72B54BACA639024C", legacy.id), {
    ok: true, variant: legacy, matchedBy: "saved_id",
  });
});

test("uses a unique exact SKU if the saved variant ID is stale", () => {
  assert.deepEqual(resolveShopifyVariantIdentity([red, blue], "TRC-blue", "gid://shopify/ProductVariant/999"), {
    ok: true, variant: blue, matchedBy: "exact_sku",
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

test("prefers a unique exact SKU over a different saved variant with a blank SKU", () => {
  const blankRed = { id: red.id, sku: null };
  assert.deepEqual(resolveShopifyVariantIdentity([blankRed, blue], "TRC-blue", red.id), {
    ok: true, variant: blue, matchedBy: "exact_sku",
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
  assert.deepEqual(
    resolveShopifyVariantIdentity([red, { ...blue, id: "gid://shopify/ProductVariant/103", sku: "TRC-red" }], "TRC-red"),
    { ok: false, reason: "variant_sku_ambiguous" },
  );
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

test("allows SKU normalization only when the caller explicitly trusts a saved variant ID", () => {
  const savedSupplierVariant = { id: "gid://shopify/ProductVariant/201", sku: "CJNS192984501AZ" };
  const sibling = { id: "gid://shopify/ProductVariant/202", sku: "CJNS192984502BY" };
  assert.deepEqual(
    resolveShopifyVariantIdentity([savedSupplierVariant, sibling], "TRC-listing-201", savedSupplierVariant.id),
    { ok: false, reason: "saved_variant_sku_mismatch" },
  );
  assert.deepEqual(
    resolveShopifyVariantIdentity([savedSupplierVariant, sibling], "TRC-listing-201", savedSupplierVariant.id, { allowSavedIdSkuMismatch: true }),
    { ok: true, variant: savedSupplierVariant, matchedBy: "saved_id" },
  );
});

test("trusted saved ID does not bypass duplicate expected SKU ambiguity", () => {
  const one = { id: "gid://shopify/ProductVariant/301", sku: "CJNS-one" };
  const two = { id: "gid://shopify/ProductVariant/302", sku: "TRC-listing" };
  const three = { id: "gid://shopify/ProductVariant/303", sku: "TRC-listing" };
  assert.deepEqual(
    resolveShopifyVariantIdentity([one, two, three], "TRC-listing", one.id, { allowSavedIdSkuMismatch: true }),
    { ok: false, reason: "variant_sku_ambiguous" },
  );
});
