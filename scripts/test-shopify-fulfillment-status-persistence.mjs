import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/shopify/sync-fulfillments.ts", import.meta.url), "utf8");
const start = source.indexOf("const persisted = await supabase");
const end = source.indexOf("result.synced += 1;", start);
assert.notEqual(start, -1, "fulfillment status update block must exist");
assert.notEqual(end, -1, "success count must exist after persistence block");
const writeBlock = source.slice(start, end);
assert.match(writeBlock, /\.update\(/, "local fulfillment status must be persisted");
assert.match(writeBlock, /if \(persisted\.error\)/, "database write errors must fail the sync result");
assert.match(writeBlock, /shopify_fulfillment_created_local_status_persist_failed/, "error must identify external success plus local persistence failure");
assert.ok(writeBlock.indexOf("if (persisted.error)") < writeBlock.indexOf("result.synced"), "sync must not be counted successful before DB persistence succeeds");
assert.match(source, /result\.failed \+= 1;/, "persistence failure must be counted as failed");
console.log("Shopify fulfillment status persistence guard: 5 assertions passed");
