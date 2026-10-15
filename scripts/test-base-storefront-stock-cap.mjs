import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "../lib/shopify/storefront-stock.ts";

assert.equal(toStorefrontStockQuantity(40000), 10, "supplier warehouse stock must not be copied to BASE");
assert.equal(toStorefrontStockQuantity(38786), 10, "large supplier stock must remain capped");
assert.equal(toStorefrontStockQuantity(4), 4, "small positive inventory remains conservative");
assert.equal(toStorefrontStockQuantity(0), 0, "zero stock remains zero");
assert.equal(toStorefrontStockQuantity(null), 0, "unknown stock fails closed");
assert.equal(toStorefrontStockQuantity(40000, 3), 3, "BASE-specific cap is honored");
assert.equal(toStorefrontStockQuantity(40000, 500), 100, "configured cap is bounded");
assert.equal(getStorefrontStockCap({ STOREFRONT_STOCK_CAP: "7", SHOPIFY_STOREFRONT_STOCK_CAP: "4", BASE_STOREFRONT_STOCK_CAP: "2" }), "7", "one shared cap overrides legacy channel caps");
assert.equal(getStorefrontStockCap({ SHOPIFY_STOREFRONT_STOCK_CAP: "6", BASE_STOREFRONT_STOCK_CAP: "3" }), "6", "legacy Shopify cap is shared when no common cap is set");
assert.equal(getStorefrontStockCap({ BASE_STOREFRONT_STOCK_CAP: "3" }), "3", "legacy BASE cap remains a fallback");

const source = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const shopify = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const stock = await readFile(new URL("../lib/shopify/storefront-stock.ts", import.meta.url), "utf8");
const patrol = await readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8");
assert.match(source, /getStorefrontStockCap\(\)/);
assert.match(shopify, /toStorefrontStockQuantity\(row\.inventory, getStorefrontStockCap\(\)\)/);
assert.match(stock, /STOREFRONT_STOCK_CAP \?\? env\.SHOPIFY_STOREFRONT_STOCK_CAP \?\? env\.BASE_STOREFRONT_STOCK_CAP/);
assert.match(source, /stock: storefrontInventory, visible: true/);
assert.doesNotMatch(source, /stock: availableInventory, visible: true/);
assert.match(patrol, /publishPublishedListingsToBase\(15\)/, "the five-minute patrol should reconcile full safe BASE batches, not only three listings");
console.log("Shared storefront stock cap: 14 assertions passed");
