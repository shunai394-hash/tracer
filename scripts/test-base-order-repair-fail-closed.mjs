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


const newOrderStart = sync.indexOf("const itemIds = baseItems.map", existingBranch);
const newOrderValidation = sync.indexOf("const unresolved = itemIds.filter", newOrderStart);
const newOrderThrow = sync.indexOf("base_items_not_uniquely_mapped", newOrderValidation);
const newOrderMap = sync.indexOf("const listingByBaseItem = new Map", newOrderValidation);
assert.ok(newOrderStart > existingBranch, "new-order import mapping must be checked");
assert.ok(newOrderValidation > newOrderStart, "new orders must reject missing or ambiguous mappings");
assert.ok(newOrderThrow > newOrderValidation, "new-order mapping failure must be explicit");
assert.ok(newOrderMap > newOrderThrow, "new-order listing map must be built only after validation");

console.log("BASE order sync fails closed on missing/ambiguous item mappings.");
