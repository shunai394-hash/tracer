import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toStorefrontStockQuantity } from "../lib/shopify/storefront-stock.ts";

assert.equal(toStorefrontStockQuantity(40000), 10, "supplier warehouse stock must not be copied to BASE");
assert.equal(toStorefrontStockQuantity(38786), 10, "large supplier stock must remain capped");
assert.equal(toStorefrontStockQuantity(4), 4, "small positive inventory remains conservative");
assert.equal(toStorefrontStockQuantity(0), 0, "zero stock remains zero");
assert.equal(toStorefrontStockQuantity(null), 0, "unknown stock fails closed");
assert.equal(toStorefrontStockQuantity(40000, 3), 3, "BASE-specific cap is honored");
assert.equal(toStorefrontStockQuantity(40000, 500), 100, "configured cap is bounded");

const source = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
assert.match(source, /BASE_STOREFRONT_STOCK_CAP/);
assert.match(source, /stock: storefrontInventory, visible: true/);
assert.doesNotMatch(source, /stock: availableInventory, visible: true/);
console.log("BASE storefront stock cap: 10 assertions passed");
