import test from "node:test";
import assert from "node:assert/strict";
import { planShopifyVariantGroups } from "../lib/commerce/shopify-variant-grouping.mjs";

const row = (overrides = {}) => ({
  product_id: "product-1",
  source_key: "cj:parent-1",
  variant_id: "variant-1",
  supplier_code: "cj",
  supplier_product_id: "parent-1",
  supplier_variant_id: "child-1",
  sku: "TRC-CHILD-1",
  selling_price: 2136,
  inventory: 10,
  shopify_product_id: null,
  shopify_variant_id: null,
  base_item_id: "base-1",
  ...overrides,
});

test("plans a canonical parent with multiple unique sellable variants without merging their identities", () => {
  const plan = planShopifyVariantGroups([
    row(),
    row({
      variant_id: "variant-2",
      supplier_variant_id: "child-2",
      sku: "TRC-CHILD-2",
      base_item_id: "base-2",
    }),
  ]);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].variantCount, 2);
  assert.equal(plan[0].canProceedToDryRunReview, true);
  assert.deepEqual(plan[0].variants.map((variant) => variant.variantId), ["variant-1", "variant-2"]);
  assert.deepEqual(plan[0].variants.map((variant) => variant.currentBaseItemId), ["base-1", "base-2"]);
});

test("blocks missing supplier variant identity, SKU, invalid price, and negative inventory", () => {
  const plan = planShopifyVariantGroups([
    row({ supplier_variant_id: "", sku: "", selling_price: 0, inventory: -1 }),
  ]);
  assert.equal(plan[0].canProceedToDryRunReview, false);
  assert.ok(plan[0].blockingReasons.some((reason) => reason.endsWith(":supplier_variant_id_missing")));
  assert.ok(plan[0].blockingReasons.some((reason) => reason.endsWith(":sku_missing")));
  assert.ok(plan[0].blockingReasons.some((reason) => reason.endsWith(":selling_price_invalid")));
  assert.ok(plan[0].blockingReasons.some((reason) => reason.endsWith(":inventory_invalid")));
});

test("blocks duplicate SKUs and duplicate supplier child identities rather than guessing", () => {
  const plan = planShopifyVariantGroups([
    row(),
    row({ variant_id: "variant-2", base_item_id: "base-2" }),
  ]);
  assert.equal(plan[0].canProceedToDryRunReview, false);
  assert.ok(plan[0].blockingReasons.some((reason) => reason.startsWith("sku_duplicated_in_group:")));
  assert.ok(plan[0].blockingReasons.some((reason) => reason.startsWith("supplier_variant_duplicated_in_group:")));
});

test("blocks groups spanning multiple existing Shopify product IDs pending an explicit migration map", () => {
  const plan = planShopifyVariantGroups([
    row({ shopify_product_id: "shop-product-1", shopify_variant_id: "shop-variant-1" }),
    row({
      variant_id: "variant-2",
      supplier_variant_id: "child-2",
      sku: "TRC-CHILD-2",
      shopify_product_id: "shop-product-2",
      shopify_variant_id: "shop-variant-2",
    }),
  ]);
  assert.equal(plan[0].canProceedToDryRunReview, false);
  assert.ok(plan[0].blockingReasons.includes("multiple_existing_shopify_products_need_migration_map"));
});

test("blocks incomplete Shopify ID pairs", () => {
  const plan = planShopifyVariantGroups([
    row({ shopify_product_id: "shop-product-1", shopify_variant_id: null }),
  ]);
  assert.equal(plan[0].canProceedToDryRunReview, false);
  assert.ok(plan[0].blockingReasons.includes("partial_shopify_mapping"));
});

test("blocks a source parent key that is split across multiple internal product IDs", () => {
  const plan = planShopifyVariantGroups([
    row({ product_id: "product-1", variant_id: "variant-1" }),
    row({
      product_id: "product-2",
      variant_id: "variant-2",
      supplier_variant_id: "child-2",
      sku: "TRC-CHILD-2",
      base_item_id: "base-2",
    }),
  ]);
  assert.equal(plan.length, 2);
  assert.ok(plan.every((group) => group.canProceedToDryRunReview === false));
  assert.ok(plan.every((group) => group.blockingReasons.includes("source_key_maps_to_multiple_internal_product_ids")));
});

test("rejects non-array input", () => {
  assert.throws(() => planShopifyVariantGroups(null), /rows_must_be_array/);
});
