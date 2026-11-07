import assert from "node:assert/strict";
import { planShopifyColorFamily } from "../lib/shopify/color-family-plan.ts";

const ids = ["sv-zebra", "sv-croc", "sv-black", "sv-blue", "sv-gray"];
const sources = ids.map((supplierVariantId, i) => ({
  productId: "gid://shopify/Product/" + (100 + i),
  variantId: "gid://shopify/ProductVariant/" + (200 + i),
  supplierVariantId,
  sku: "TRC-COLOR-" + i,
  colorLabel: ["ゼブラ柄", "クロコ柄", "ブラック", "ブルー", "グレー・ブラック"][i],
  imageUrl: "https://cdn.example.test/" + i + ".jpg",
  price: 11546,
  inventory: 10,
}));

const valid = planShopifyColorFamily({
  canonicalProductId: "gid://shopify/Product/100",
  sources,
  expectedSupplierVariantIds: ids,
});
assert.equal(valid.ok, true);
assert.equal(valid.variants.length, 5);
assert.deepEqual(valid.variants.map((v) => v.supplierVariantId), ids);
assert.deepEqual(valid.variants.map((v) => v.colorLabel), ["ゼブラ柄", "クロコ柄", "ブラック", "ブルー", "グレー・ブラック"]);
assert.deepEqual(valid.destructiveActions, []);

const missingImage = planShopifyColorFamily({
  canonicalProductId: "gid://shopify/Product/100",
  sources: sources.map((s, i) => i === 2 ? { ...s, imageUrl: "" } : s),
  expectedSupplierVariantIds: ids,
});
assert.equal(missingImage.ok, false);
assert.ok(missingImage.blockers.includes("variant_image_missing:sv-black"));

const duplicate = planShopifyColorFamily({
  canonicalProductId: "gid://shopify/Product/100",
  sources: [...sources, sources[0]],
  expectedSupplierVariantIds: ids,
});
assert.equal(duplicate.ok, false);
assert.ok(duplicate.blockers.includes("supplier_variant_ambiguous:sv-zebra"));

const missing = planShopifyColorFamily({
  canonicalProductId: "gid://shopify/Product/100",
  sources: sources.slice(1),
  expectedSupplierVariantIds: ids,
});
assert.equal(missing.ok, false);
assert.ok(missing.blockers.includes("expected_supplier_variant_missing:sv-zebra"));

console.log("Shopify color family migration plan: 4 scenarios passed");
