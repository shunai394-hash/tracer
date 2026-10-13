import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/channels/base/identity-repair/route.ts", import.meta.url), "utf8");
const base = await readFile(new URL("../lib/channels/base.ts", import.meta.url), "utf8");
const publisher = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");

assert.match(route, /TRC-\(\[0-9a-f\]/i);
assert.match(route, /fetchBaseItemsSnapshot/);
assert.match(route, /base_create_id_persist_failed/ , "repair may use only the exact persisted BASE create response marker");
assert.match(route, /persisted_create_marker/);
assert.match(route, /identity_evidence_ambiguous/);
assert.match(route, /snapshot\.complete/, "an incomplete BASE scan must never be used for repair");
assert.match(route, /body\.apply === true/, "writes must require explicit apply:true");
assert.match(route, /\.eq\("id", listingId\)[\s\S]*?\.is\("base_item_id", null\)/, "repair must compare-and-set only missing IDs");
assert.match(route, /listing_has_different_base_item_id/);
assert.match(route, /base_item_already_mapped_to_other_listing/);
assert.doesNotMatch(route, /\.update\(\{[^}]*published\s*:/, "identity repair must not change publication state");
assert.match(base, /identifier\?: string/);
assert.match(publisher, /identifier: `TRC-\$\{listingId\}`/);
console.log("BASE exact identifier repair safety: 8 assertions passed");
