import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");

// Amazon/Rakuten are excluded by policy and Yahoo is the only enabled source,
// so empty child-variant evidence is always retryable, never observation-only.
assert.ok(!pipeline.includes("sourceDoesNotProvideCanonicalChildVariants"), "the cursor index must not mark the enabled Yahoo source as observation-only");
assert.ok(!pipeline.includes("retryable: !nonBlockingSourceCoverageSkip"), "empty Yahoo child-variant evidence must not be a non-blocking skip");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped source rows must never feed the sales gate");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = canFeedSalesGate(bestsellerStep)"), "downstream sales matching must use the strict gate helper");
assert.ok(pipeline.includes("retryable: bestsellerStep.retryable === true"), "dropship must inherit the source stage retryability instead of always deferring");
assert.ok(pipeline.includes('"bestseller_source_has_no_canonical_child_variant_contract"'), "dropship must distinguish observation-only sources from retryable Amazon evidence");
console.log("Marketplace canonical evidence policy: 6 assertions passed");
