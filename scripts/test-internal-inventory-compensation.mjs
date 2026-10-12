import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("lib/procurement/tracer-internal-adapter.ts", "utf8");
const helperStart = source.indexOf("async function releaseInventoryReservation(");
const helperEnd = source.indexOf("\nasync function loadVariant(", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "compensation helper must exist");
const helper = source.slice(helperStart, helperEnd);

assert.match(helper, /if \(released\.error\)/, "release RPC errors must be checked");
assert.match(helper, /inventory_reservation_release_failed:/, "release RPC failure must be explicit");
assert.match(helper, /restored_inventory/, "release return inventory must be validated");
assert.match(helper, /inventory_reservation_release_returned_no_inventory/, "missing release result must fail closed");
assert.match(helper, /inventory_reservation_released_projection_sync_failed:/, "projection repair failure must be explicit");

const calls = [...source.matchAll(/releaseInventoryReservation\(supabase, input\.supplierVariantId, input\.quantity\)/g)];
assert.equal(calls.length, 3, "all compensation paths must use the checked helper");
assert.doesNotMatch(source, /if \(!released\.error && released\.data\?\.\[0\]\?\.restored_inventory/, "unchecked compensation must not remain");

console.log("Internal inventory compensation guards: 7 passed");
