import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = await readFile(new URL("../lib/channels/base.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/channels/base/delete-stale-items/route.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/base-stale-item-deletion.yml", import.meta.url), "utf8");

for (const id of ["163159366", "163159368", "163159369"]) {
  assert.ok(base.includes(`"${id}"`), `BASE delete primitive must allowlist ${id}`);
  assert.ok(route.includes(`staleId: "${id}"`), `route must target ${id}`);
}
for (const id of ["163355942", "163355946", "163355950"]) {
  assert.ok(route.includes(`canonicalId: "${id}"`), `route must protect canonical ID ${id}`);
}
assert.ok(base.includes('requestBase("/items/delete"'), "deletion must use the BASE item-delete endpoint");
assert.ok(route.includes('body.apply === true'), "route must default to read-only");
assert.ok(route.includes('body.confirmation !== CONFIRMATION'), "apply must require exact confirmation");
assert.ok(route.includes("fetchBaseItemsSnapshot"), "route must use complete BASE snapshots");
assert.ok(route.includes("STALE_SKU_MISMATCH"), "route must fail closed on stale SKU mismatch");
assert.ok(route.includes("CANONICAL_PRICE_OR_VISIBILITY_MISMATCH"), "route must protect canonical price/publication");
assert.ok(route.includes("DELETE_READBACK_STALE_ITEM_STILL_PRESENT"), "delete response alone must not count as success");
assert.ok(route.includes("CANONICAL_READBACK_FAILED"), "canonical item must be checked after deletion");
assert.ok(route.includes("STALE_LISTING_REFERENCE_CHECK_FAILED"), "route must refuse deletion when a listing still points at a stale ID");
assert.ok(route.includes("deletionBlocked"), "route must block deletion until order and listing references are clear");
assert.ok(route.includes("getBaseOrderDetail"), "route must read live BASE orders before deletion");
assert.ok(workflow.includes("default: false"), "workflow apply input must default to false");
assert.ok(workflow.includes("DELETE_THREE_STALE_BASE_ITEMS"), "workflow must require exact confirmation");
assert.ok(workflow.includes("snapshotComplete") && workflow.includes("stalePresent"), "workflow must validate dry-run evidence");
console.log("BASE stale-item deletion contract: 20 assertions passed");
