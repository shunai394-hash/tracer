import assert from "node:assert/strict";
import { canFeedSalesGate } from "../lib/intelligence/bestseller-sales-gate.ts";

assert.equal(canFeedSalesGate({ ok: true }), true, "completed stage can feed sales gate");
assert.equal(canFeedSalesGate({ ok: true, skipped: true }), false, "skipped stage is blocked");
assert.equal(canFeedSalesGate({ ok: true, retryable: true }), false, "retryable stage is blocked");
assert.equal(canFeedSalesGate({ ok: true, skipped: true, retryable: true }), false, "deferred stage is blocked");
assert.equal(canFeedSalesGate({ ok: false }), false, "failed stage is blocked");
console.log("bestseller sales-gate behavior verified");

import { readFileSync } from "node:fs";
const pipeline = readFileSync("lib/intelligence/run-intelligence-pipeline.ts", "utf8");
const dropshipBlock = pipeline.match(/runStep\("dropship",[\s\S]*?\n  \}, \{ budgetMs: 30_000 \}\)\)/);
assert.ok(dropshipBlock, "dropship step must exist");
assert.match(dropshipBlock[0], /if \(!bestsellerCanFeedSalesGate\)/, "pending marketplace backlog must not bypass the canonical-evidence gate");
assert.match(dropshipBlock[0], /bestseller_canonical_evidence_deferred/, "deferred marketplace backlog must be explicitly marked retryable");
