import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const cursorWrite = source.indexOf('const next = await writeMarketCursor(db, observation, "patrol-ai")');
const emptyGuard = source.indexOf("if (observation.itemCount === 0)", cursorWrite);
const retryable = source.indexOf('reason: "marketplace_collection_empty"', emptyGuard);
const returnStep = source.indexOf("return { ...observation, cursor, nextCursor: next };", emptyGuard);

assert.ok(cursorWrite >= 0, "market cursor must be persisted before the empty-result retry decision");
assert.ok(emptyGuard > cursorWrite, "empty-result guard must run after the cursor advances");
assert.ok(retryable > emptyGuard, "empty collection must be explicitly retryable");
assert.ok(source.slice(emptyGuard, returnStep).includes("skipped: true"), "empty collection must be marked deferred, not complete");
assert.ok(source.slice(emptyGuard, returnStep).includes("retryable: true"), "empty collection must schedule a later retry");
console.log("PASS: empty marketplace collection cannot be reported as a complete patrol");
