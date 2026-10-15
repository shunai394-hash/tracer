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
const dropshipBlock = pipeline.match(/steps\.push\(\{\s*name: "dropship",[\s\S]*?\n  \}\);/);
assert.ok(dropshipBlock, "dropship step must remain visible in pipeline telemetry");
assert.match(dropshipBlock[0], /skipped: true/, "marketplace-ranking procurement path must be disabled");
assert.match(dropshipBlock[0], /marketplace_rankings_not_used_for_supplier_procurement/, "reason must clearly state rankings are not supplier sources");
assert.match(pipeline, /dedicated CJ supply-first path[\s\S]*?directly verifies the exact CJ product\/variant/i, "procurement must use direct CJ supply-first verification");
assert.doesNotMatch(pipeline, /investigateDropshipForBestsellers/, "ranking candidates must not be passed to supplier investigation");
