import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const cron = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const requiredSignals = ["variationAsinsFound","childDetailAttempted","childDetailFetched","childBarcodeFound"];
function testSourceHasUniqueRecoveredMerge(value) {
  return value.includes("recoveredBySourceId.get(variant.sourceVariantId) ?? variant")
    && value.includes("const existingSourceIds = new Set(item.canonicalVariants.map((variant) => variant.sourceVariantId))");
}

for (const signal of requiredSignals) assert.ok(source.includes(signal), `missing diagnostic signal: ${signal}`);
assert.ok(source.indexOf("if (!jan && !gtin && !ean && !upc) return null;") < source.indexOf("childBarcodeFound += 1;"), "barcode count must follow concrete barcode validation");
assert.ok(source.includes("childDetailAttempted += childAsins.length;"), "count child attempts before fetch");
assert.ok(source.includes("childDetailFetched += 1;"), "count successful detail fetches");
assert.ok(source.includes("parseAmazonVariationAsinMap(html, url).length > 0"), "Bright Data HTML with an explicit child-ASIN map must count as variant evidence");
assert.ok(source.includes("hasAmazonVariantEvidence(page.html)"), "retain Bright Data page when it improves child-variant evidence");
for (const signal of ["canonicalVariantEvidenceParsed", "canonicalVariantEvidenceWritten", "canonicalVariantEvidenceWriteFailures", "canonicalVariantEvidenceStatus"]) {
  assert.ok(cron.includes(signal), `market-sourcing cron must expose ${signal}`);
}
assert.ok(cron.includes('"no_canonical_variant_evidence"'), "zero parsed variants must be reported as no evidence, never success");
assert.ok(cron.includes('"write_failed"'), "evidence persistence failures must be reported separately");
assert.ok(source.includes("const hasBarcodeBearingChild = item.canonicalVariants.some("), "a parent ProductGroup with barcode-less child nodes must still trigger child-ASIN detail enrichment");
assert.ok(testSourceHasUniqueRecoveredMerge(source), "recovered child detail evidence must replace barcode-less rows with the same source variant ID without duplicate upsert keys");

console.log("Amazon child variant diagnostics: extraction, persistence and cron reporting assertions passed");
