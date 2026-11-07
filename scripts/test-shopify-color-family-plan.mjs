import assert from "node:assert/strict";
import { planShopifyColorFamily } from "../lib/shopify/color-family-plan.ts";

const ids = ["sv-zebra", "sv-croc", "sv-black", "sv-blue", "sv-gray"];
const supplierProductId = "CJ-PRODUCT-EXACT-001";
const sources = ids.map((supplierVariantId, i) => ({
  productId: "gid://shopify/Product/" + (100 + i),
  variantId: "gid://shopify/ProductVariant/" + (200 + i),
  supplierCode: "cj",
  supplierProductId,
  supplierVariantId,
  sku: "TRC-COLOR-" + i,
  colorLabel: ["ゼブラ柄", "クロコ柄", "ブラック", "ブルー", "グレー・ブラック"][i],
  imageUrl: "https://cdn.example.test/" + i + ".jpg",
  price: 11546,
  inventory: 10,
}));

const input = {
  canonicalProductId: "gid://shopify/Product/100",
  expectedSupplierCode: "cj",
  expectedSupplierProductId: supplierProductId,
  sources,
  expectedSupplierVariantIds: ids,
};
const valid = planShopifyColorFamily(input);
assert.equal(valid.ok, true);
assert.equal(valid.variants.length, 5);
assert.deepEqual(valid.variants.map((v) => v.supplierVariantId), ids);
assert.deepEqual(valid.variants.map((v) => v.colorLabel), ["ゼブラ柄", "クロコ柄", "ブラック", "ブルー", "グレー・ブラック"]);
assert.ok(valid.variants.every((v) => v.supplierCode === "cj" && v.supplierProductId === supplierProductId));
assert.deepEqual(valid.destructiveActions, []);

const missingImage = planShopifyColorFamily({
  ...input,
  sources: sources.map((s, i) => i === 2 ? { ...s, imageUrl: "" } : s),
});
assert.equal(missingImage.ok, false);
assert.ok(missingImage.blockers.includes("variant_image_missing:sv-black"));

const insecureImage = planShopifyColorFamily({
  ...input,
  sources: sources.map((s, i) => i === 1 ? { ...s, imageUrl: "http://cdn.example.test/1.jpg" } : s),
});
assert.equal(insecureImage.ok, false);
assert.ok(insecureImage.blockers.includes("variant_image_missing:sv-croc"));

const wrongSupplierNamespace = planShopifyColorFamily({
  ...input,
  sources: sources.map((s, i) => i === 3 ? { ...s, supplierCode: "other" } : s),
});
assert.equal(wrongSupplierNamespace.ok, false);
assert.ok(wrongSupplierNamespace.blockers.includes("supplier_code_mismatch:sv-blue"));

const wrongSupplierProduct = planShopifyColorFamily({
  ...input,
  sources: sources.map((s, i) => i === 3 ? { ...s, supplierProductId: "CJ-OTHER-PRODUCT" } : s),
});
assert.equal(wrongSupplierProduct.ok, false);
assert.ok(wrongSupplierProduct.blockers.includes("supplier_product_id_mismatch:sv-blue"));

const duplicateSupplierId = planShopifyColorFamily({
  ...input,
  sources: [...sources, sources[0]],
});
assert.equal(duplicateSupplierId.ok, false);
assert.ok(duplicateSupplierId.blockers.includes("supplier_variant_ambiguous:sv-zebra"));

const missingSupplierId = planShopifyColorFamily({
  ...input,
  sources: sources.slice(1),
});
assert.equal(missingSupplierId.ok, false);
assert.ok(missingSupplierId.blockers.includes("expected_supplier_variant_missing:sv-zebra"));

const duplicateSku = planShopifyColorFamily({
  ...input,
  sources: sources.map((s, i) => i === 1 ? { ...s, sku: sources[0].sku } : s),
});
assert.equal(duplicateSku.ok, false);
assert.ok(duplicateSku.blockers.includes("sku_ambiguous:" + sources[0].sku));

const duplicateShopifyVariant = planShopifyColorFamily({
  ...input,
  sources: sources.map((s, i) => i === 1 ? { ...s, variantId: sources[0].variantId } : s),
});
assert.equal(duplicateShopifyVariant.ok, false);
assert.ok(duplicateShopifyVariant.blockers.includes("shopify_variant_id_ambiguous:" + sources[0].variantId));

const duplicateColorLabel = planShopifyColorFamily({
  ...input,
  sources: sources.map((s, i) => i === 1 ? { ...s, colorLabel: sources[0].colorLabel } : s),
});
assert.equal(duplicateColorLabel.ok, false);
assert.ok(duplicateColorLabel.blockers.includes("color_label_ambiguous:" + sources[0].colorLabel.toLocaleLowerCase("ja-JP")));

const duplicateExpected = planShopifyColorFamily({
  ...input,
  expectedSupplierVariantIds: [...ids, ids[0]],
});
assert.equal(duplicateExpected.ok, false);
assert.ok(duplicateExpected.blockers.includes("expected_supplier_variant_id_duplicate"));

console.log("Shopify color family migration plan: 10 scenarios passed");
