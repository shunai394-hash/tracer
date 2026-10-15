import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");

assert.ok(pipeline.includes("const sourceDoesNotProvideCanonicalChildVariants = observation.sourceIndex < 2"), "Yahoo/Rakuten source indices must be treated as observation-only for child-variant sales identity");
assert.ok(pipeline.includes("retryable: !nonBlockingSourceCoverageSkip"), "unsupported variant evidence should not block unrelated pipeline stages");
assert.ok(pipeline.includes('"source_has_no_canonical_child_variant_contract"'), "report the exact non-blocking source limitation");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped source rows must never feed the sales gate");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = canFeedSalesGate(bestsellerStep)"), "downstream sales matching must use the strict gate helper");
assert.ok(pipeline.includes('reason: "marketplace_rankings_not_used_for_supplier_procurement"'), "ranking observations must not be treated as supplier procurement inputs");
assert.ok(pipeline.includes('discoveryCron: "/api/cron/supply-first"'), "supplier procurement must be routed to the dedicated supply-first cron");
assert.doesNotMatch(pipeline, /investigateDropshipForBestsellers/, "legacy ranking-driven supplier investigation must not run in the intelligence pipeline");
console.log("Marketplace canonical evidence policy: 8 assertions passed");
