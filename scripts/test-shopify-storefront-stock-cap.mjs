import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toStorefrontStockQuantity } from "../lib/shopify/storefront-stock.ts";
assert.equal(toStorefrontStockQuantity(40000), 10);
assert.equal(toStorefrontStockQuantity("38003"), 10);
assert.equal(toStorefrontStockQuantity(9), 9);
assert.equal(toStorefrontStockQuantity(40000, 25), 25);
assert.equal(toStorefrontStockQuantity(40000, 500), 100);
assert.equal(toStorefrontStockQuantity(40000, 0), 10);
assert.equal(toStorefrontStockQuantity(0), 0);
assert.equal(toStorefrontStockQuantity(-1), 0);
assert.equal(toStorefrontStockQuantity("unknown"), 0);
assert.equal(toStorefrontStockQuantity(null), 0);
const [sync, store] = await Promise.all([
  readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8"),
]);
assert.match(sync, /toStorefrontStockQuantity\(row\.inventory, process\.env\.SHOPIFY_STOREFRONT_STOCK_CAP\)/);
assert.match(sync, /getLiveShopifyStock\(alreadySyncedVariantIds\)/);
assert.match(sync, /liveQuantity === undefined \|\| liveQuantity !== toStorefrontStockQuantity/);
assert.match(sync, /row\.pipeline_stage === "BASE_PUBLISHED"/);
assert.match(store, /export async function getLiveShopifyStock/);
console.log("Shopify storefront stock cap and drift reconciliation invariants passed.");
