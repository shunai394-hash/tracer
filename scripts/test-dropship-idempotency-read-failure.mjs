import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/ordering/dropship.ts", import.meta.url), "utf8");
const lookupStart = source.indexOf("const { data: existingPo, error: existingPoLookupError }");
assert.notEqual(lookupStart, -1, "purchase-order idempotency lookup must expose database errors");
const failClosed = source.indexOf('reason: "purchase_order_idempotency_lookup_failed"', lookupStart);
const purchaseOrderInsert = source.indexOf('.from("purchase_orders")\n        .insert(', lookupStart);
assert.notEqual(failClosed, -1, "lookup errors must be recorded as skipped");
assert.notEqual(purchaseOrderInsert, -1, "purchase-order insert path must exist");
assert.ok(failClosed < purchaseOrderInsert, "lookup failure must be handled before a new purchase order can be inserted");
const continueIndex = source.indexOf("continue;", failClosed);
assert.ok(continueIndex > failClosed && continueIndex < purchaseOrderInsert, "lookup failure must stop processing this order line");
console.log("PASS: dropship idempotency lookup fails closed before purchase-order insertion");
