import assert from "node:assert/strict";
import {
  expectedShopifySku,
  indexShopifyCatalog,
  reconcileShopifyListing,
  summarizeShopifyListingReconciliation,
} from "./shopify-reconciliation-core.mjs";

const catalog = indexShopifyCatalog([{
  id: "gid://shopify/Product/100",
  legacyResourceId: "100",
  title: "床用フロアマット",
  status: "ACTIVE",
  variants: {
    nodes: [{
      id: "gid://shopify/ProductVariant/200",
      legacyResourceId: "200",
      sku: "TRC-variant-1",
      price: "3980.00",
      inventoryQuantity: 12,
    }],
  },
}]);

const matching = {
  id: "listing-1",
  shopify_product_id: "gid://shopify/Product/100",
  shopify_variant_id: "gid://shopify/ProductVariant/200",
  supplier_variant_id: "variant-1",
  supplier_product_id: "supplier-product-1",
  selling_price: 3980,
  inventory: 12,
  published: true,
};
assert.equal(expectedShopifySku(matching), "TRC-variant-1");
const good = reconcileShopifyListing(matching, catalog);
assert.deepEqual(good.mismatches, []);
assert.equal(good.skuMatches, true);
assert.equal(good.priceMatches, true);
assert.equal(good.inventoryMatches, true);

const mismatch = reconcileShopifyListing({
  ...matching,
  selling_price: 3990,
  inventory: 11,
  supplier_variant_id: "different-variant",
}, catalog);
assert.ok(mismatch.mismatches.includes("sku_mismatch"));
assert.ok(mismatch.mismatches.includes("price_mismatch"));
assert.ok(mismatch.mismatches.includes("inventory_mismatch"));

const missing = reconcileShopifyListing({
  ...matching,
  shopify_product_id: "gid://shopify/Product/404",
  shopify_variant_id: "gid://shopify/ProductVariant/405",
}, catalog);
assert.ok(missing.mismatches.includes("shopify_product_missing"));
assert.ok(missing.mismatches.includes("shopify_variant_missing"));

const statusDisagreement = reconcileShopifyListing({ ...matching, published: false }, catalog);
assert.ok(statusDisagreement.mismatches.includes("db_unpublished_but_shopify_product_active_status"));

const summary = summarizeShopifyListingReconciliation([good, mismatch, missing, statusDisagreement]);
assert.equal(summary.comparedListings, 4);
assert.equal(summary.skuMismatch, 1);
assert.equal(summary.priceMismatch, 1);
assert.equal(summary.inventoryMismatch, 1);
assert.equal(summary.productMissing, 1);
assert.equal(summary.variantMissing, 1);
assert.equal(summary.statusDisagreement, 1);

console.log("PASS Shopify listing reconciliation core");
