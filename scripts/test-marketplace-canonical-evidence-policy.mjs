import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");
const variantParser = await readFile(new URL("../lib/market/canonical-variant-evidence.ts", import.meta.url), "utf8");
const variantConstraintMigration = await readFile(new URL("../supabase/migrations/20261015113000_allow_schema_org_inverse_variant_evidence.sql", import.meta.url), "utf8");

assert.ok(pipeline.includes("const sourceDoesNotProvideCanonicalChildVariants = observation.sourceIndex < 2"), "Yahoo/Rakuten source indices must be treated as observation-only for child-variant sales identity");
assert.ok(pipeline.includes("retryable: !nonBlockingSourceCoverageSkip"), "unsupported variant evidence should not block unrelated pipeline stages");
assert.ok(pipeline.includes('"source_has_no_canonical_child_variant_contract"'), "report the exact non-blocking source limitation");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped source rows must never feed the sales gate");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = canFeedSalesGate(bestsellerStep)"), "downstream sales matching must use the strict gate helper");
assert.ok(pipeline.includes("retryable: bestsellerStep.retryable === true"), "dropship must inherit the source stage retryability instead of always deferring");
assert.ok(pipeline.includes('"bestseller_source_has_no_canonical_child_variant_contract"'), "dropship must distinguish observation-only sources from retryable Amazon evidence");
assert.ok(variantParser.includes('evidenceSource: "schema_org_product_is_variant_of"'), "parser must retain inverse Schema.org child-to-parent evidence");
for (const source of ["schema_org_product_group_has_variant", "schema_org_product_is_variant_of", "amazon_variation_asin_map"]) {
  assert.ok(variantConstraintMigration.includes("\'" + source + "\'"), "DB constraint must allow parser evidence source: " + source);
}
console.log("Marketplace canonical evidence policy: parser and DB constraint aligned");
