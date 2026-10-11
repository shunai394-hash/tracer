import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");

assert.ok(pipeline.includes("const sourceDoesNotProvideCanonicalChildVariants = observation.sourceIndex < 2"), "Yahoo/Rakuten source indices must be treated as observation-only for child-variant sales identity");
assert.ok(pipeline.includes("retryable: !nonBlockingSourceCoverageSkip"), "unsupported variant evidence should not block unrelated pipeline stages");
assert.ok(pipeline.includes('"source_has_no_canonical_child_variant_contract"'), "report the exact non-blocking source limitation");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped source rows must never feed the sales gate");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = canFeedSalesGate(bestsellerStep)"), "downstream sales matching must use the strict gate helper");
assert.ok(pipeline.includes("retryable: bestsellerStep.retryable === true"), "dropship must inherit the source stage retryability instead of always deferring");
assert.ok(pipeline.includes('"bestseller_source_has_no_canonical_child_variant_contract"'), "dropship must distinguish observation-only sources from retryable Amazon evidence");

const cjIdentity = await readFile(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8");
assert.ok(cjIdentity.includes('["schema_org_product_group_has_variant", "amazon_variation_asin_map"]'), "accept explicit Amazon child-ASIN evidence only after that child page supplied its own barcode");
assert.ok(cjIdentity.includes("row.evidence_source"), "supplier identity must remain tied to explicit marketplace variant evidence");

console.log("Marketplace canonical evidence policy: 9 assertions passed");
