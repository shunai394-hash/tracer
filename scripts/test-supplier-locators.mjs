import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSupplierUrl,
  normalizeSupplierLocator,
  compareSupplierLocators,
  resolveSupplierCandidateProductId,
} from "../lib/catalog/supplier-locators.ts";

test("supplier product + variant IDs locate an offer without a marketplace barcode", () => {
  const result = compareSupplierLocators(
    { supplier: "CJ", supplierProductId: "P-100", supplierVariantId: "V-RED" },
    { supplier: "cj", supplierProductId: "P-100", supplierVariantId: "V-RED" },
  );
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "exact");
  assert.equal(result.method, "supplier_product_and_variant");
});

test("same product but different variants never matches", () => {
  const result = compareSupplierLocators(
    { supplier: "cj", supplierProductId: "P-100", supplierVariantId: "V-RED" },
    { supplier: "cj", supplierProductId: "P-100", supplierVariantId: "V-BLUE" },
  );
  assert.equal(result.matched, false);
  assert.equal(result.reason, "supplier_variant_mismatch");
});

test("product ID without variant locates a family but does not claim exact variant", () => {
  const result = compareSupplierLocators(
    { supplier: "cj", supplierProductId: "P-100" },
    { supplier: "cj", supplierProductId: "P-100", supplierVariantId: "V-RED" },
  );
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "strong");
  assert.equal(result.reason, "product_located_variant_unresolved");
});

test("normalized supplier URLs match after tracking parameters and fragments are removed", () => {
  assert.equal(
    normalizeSupplierUrl("https://CJ.example/item/123/?utm_source=x#variant"),
    "https://cj.example/item/123",
  );
  const result = compareSupplierLocators(
    { supplier: "cj", productUrl: "https://cj.example/item/123?utm_campaign=a" },
    { supplier: "cj", productUrl: "https://cj.example/item/123#details" },
  );
  assert.equal(result.matched, true);
  assert.equal(result.method, "supplier_url");
});

test("URLs with credentials and non-http schemes are rejected", () => {
  assert.equal(normalizeSupplierUrl("javascript:alert(1)"), null);
  assert.equal(normalizeSupplierUrl("https://user:pass@example.com/item"), null);
});

test("SKU is only a candidate locator, not exact identity", () => {
  const result = compareSupplierLocators(
    { supplier: "cj", sku: "sku-42" },
    { supplier: "cj", sku: "SKU-42" },
  );
  assert.equal(result.matched, true);
  assert.equal(result.confidence, "candidate");
});

test("locators from different suppliers never cross-match", () => {
  const result = compareSupplierLocators(
    { supplier: "cj", supplierProductId: "P-100", supplierVariantId: "V-RED" },
    { supplier: "other", supplierProductId: "P-100", supplierVariantId: "V-RED" },
  );
  assert.equal(result.matched, false);
});

test("first supplier discovery keeps the existing product row instead of inventing an orphan ID", () => {
  assert.equal(resolveSupplierCandidateProductId({
    discoveredProductId: "product-row-1",
    existingProductId: null,
    existingIdentityStatus: null,
  }), "product-row-1");
});

test("retry reuses a retained supply-discovered product ID", () => {
  assert.equal(resolveSupplierCandidateProductId({
    discoveredProductId: "new-fallback-row",
    existingProductId: "stable-candidate-row",
    existingIdentityStatus: "supply_discovered",
  }), "stable-candidate-row");
});

test("a proven marketplace identity takes precedence over the supplier candidate row", () => {
  assert.equal(resolveSupplierCandidateProductId({
    marketplaceProductId: "canonical-market-row",
    discoveredProductId: "supplier-candidate-row",
    existingProductId: "prior-candidate-row",
    existingIdentityStatus: "supply_discovered",
  }), "canonical-market-row");
});
