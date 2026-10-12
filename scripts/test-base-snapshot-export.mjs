import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/admin/channels/base/snapshot/route.ts", import.meta.url), "utf8");
const client = await readFile(new URL("../lib/channels/base.ts", import.meta.url), "utf8");

assert.match(route, /requireAutomationAuth/);
assert.match(route, /fetchBaseItemsSnapshot/);
assert.match(route, /Content-Disposition/);
assert.match(route, /Cache-Control.*no-store/);
assert.match(route, /complete: snapshot\.complete/);
assert.match(route, /items: snapshot\.items/);
assert.doesNotMatch(route, /console\.(?:info|log)\([^\n]*(?:items|snapshot)/);
assert.match(client, /BASE_ITEMS_SNAPSHOT_INCOMPLETE/);
assert.match(client, /BASE_ITEMS_SNAPSHOT_ID_MISSING_OR_DUPLICATE/);
assert.match(client, /new Set\(ids\)\.size !== ids\.length/);
console.log("BASE product snapshot export contract: 9 assertions passed");
