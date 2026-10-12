import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const start = source.indexOf("Supplier stock is evidence for order-time validation");
const end = source.indexOf("const publication = await ensureShopifyProductPublished", start);
assert.ok(start >= 0 && end > start, "sync must document the supplier/saleable-stock boundary");
const inventoryBlock = source.slice(start, end);
assert.match(inventoryBlock, /quantity:\s*0\s*,/, "unverified saleable inventory must fail closed at zero");
assert.match(inventoryBlock, /saleable-stock-unverified/, "zero stock write must have an explicit audit reference");
assert.doesNotMatch(inventoryBlock, /Number\(row\.inventory\)/, "supplier inventory must never be copied into Shopify available stock");
console.log("Shopify supplier-vs-saleable inventory boundary: 3 assertions passed");
