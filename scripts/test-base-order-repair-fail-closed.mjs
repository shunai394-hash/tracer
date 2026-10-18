import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/channels/base-orders.ts", import.meta.url), "utf8");
const start = source.indexOf("async function repairBaseOrderItems(");
const end = source.indexOf("\nexport async function syncBaseOrdersToTracer", start);
assert.ok(start >= 0 && end > start, "repairBaseOrderItems must exist");
const repair = source.slice(start, end);

const validation = repair.indexOf("const unresolved = itemIds.filter");
const validationThrow = repair.indexOf("base_order_items_not_uniquely_mapped");
const upsert = repair.indexOf('.from("shop_order_items")');
assert.ok(validation >= 0, "all item IDs must be checked for unique listing mappings");
assert.ok(validationThrow > validation, "missing or ambiguous mappings must fail closed");
assert.ok(upsert > validationThrow, "no order-item upsert may happen before mapping validation");
assert.match(repair, /\?\.length \?\? 0\) !== 1/, "each BASE item must map to exactly one listing");

const sync = source.slice(end);
const existingBranch = sync.indexOf("if (existing?.id)");
const repairCall = sync.indexOf("await repairBaseOrderItems", existingBranch);
const procurementCall = sync.indexOf("createDropshipPurchaseOrdersForShopOrder", existingBranch);
assert.ok(existingBranch >= 0 && repairCall > existingBranch, "existing orders must be repaired");
assert.ok(procurementCall > repairCall, "procurement must occur only after repair returns successfully");

console.log("BASE existing-order repair fails closed on missing/ambiguous item mappings.");
