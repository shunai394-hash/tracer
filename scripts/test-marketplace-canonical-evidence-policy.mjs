import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");

// All marketplace ranking sources are disabled. The pipeline must rely on
// direct supplier discovery and retain strict sales-test gates.
assert.ok(pipeline.includes('reason: "marketplace_ranking_sources_disabled_by_policy"'), "ranking intake must be explicitly disabled");
assert.ok(!pipeline.includes("sourceDoesNotProvideCanonicalChildVariants"), "no ranking source should be treated as an enabled identity source");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped source rows must never feed the sales gate");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = canFeedSalesGate(bestsellerStep)"), "downstream sales matching must use the strict gate helper");
assert.ok(pipeline.includes("retryable: bestsellerStep.retryable === true"), "dropship must inherit the source stage retryability instead of always deferring");
assert.ok(pipeline.includes('runStep("supply_first"'), "supplier-first discovery must continue");
assert.ok(pipeline.includes('runStep("supply_sales_test_select"'), "supplier products must still pass strict sales-test gates");
console.log("Marketplace ranking disabled / supplier-first policy checks passed");
