import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publisher = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
assert.ok(publisher.includes("base_create_id_persist_failed:${baseItemId}:"), "persist failure must retain the exact BASE ID");
assert.ok(publisher.includes('match(/^base_create_id_persist_failed:([^:]+)(?::|$)/)'), "retry must recognize the recovery marker");
assert.ok(publisher.includes("base_create_id_recovery_failed:"), "recovery DB failures must be explicit");
assert.ok(publisher.includes("await editBaseItem({ itemId: baseItemId"), "recovered ID must edit the existing BASE item");
assert.ok(publisher.includes("failure_marker_write_failed:"), "failure to persist recovery marker must be surfaced");
assert.ok(publisher.includes("base_last_error.like.base_create_id_persist_failed:*"), "normal cron must select recovery markers for retry");
assert.ok(publisher.includes('base_publication_status: "failed"') && publisher.includes('base_publication_lease_until: null'), "failed attempts must release the lease");
console.log("BASE create-ID recovery contract: 7 assertions passed");
