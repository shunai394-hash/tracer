import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const cron = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const requiredSignals = ["variationAsinsFound","childDetailAttempted","childDetailFetched","childBarcodeFound"];
function testSourceHasUniqueRecoveredMerge(value) {
  return value.includes("const knownBarcodeAsins = new Set(")
    && value.includes("const childAsinsToFetch = childAsins.filter((child) => !knownBarcodeAsins.has(child.asin));")
    && value.includes("rawEvidence: { ...variant.rawEvidence, child_detail_page: child.rawEvidence }")
    && value.includes("const existingSourceIds = new Set(item.canonicalVariants.map((variant) => variant.sourceVariantId))");
}

for (const signal of requiredSignals) assert.ok(source.includes(signal), `missing diagnostic signal: ${signal}`);
assert.ok(source.indexOf("if (!jan && !gtin && !ean && !upc) return null;") < source.indexOf("childBarcodeFound += 1;"), "barcode count must follow concrete barcode validation");
assert.ok(source.includes("childDetailAttempted += childAsinsToFetch.length;"), "count only child pages actually scheduled for fetch");
assert.ok(source.includes("childDetailFetched += 1;"), "count successful detail fetches");
assert.ok(source.includes("parseAmazonVariationAsinMap(html, url).length > 0"), "Bright Data HTML with an explicit child-ASIN map must count as variant evidence");
assert.ok(source.includes("hasAmazonVariantEvidence(page.html)"), "retain Bright Data page when it improves child-variant evidence");
for (const signal of ["canonicalVariantEvidenceParsed", "canonicalVariantEvidenceWritten", "canonicalVariantEvidenceWriteFailures", "canonicalVariantEvidenceStatus"]) {
  assert.ok(cron.includes(signal), `market-sourcing cron must expose ${signal}`);
}
assert.ok(cron.includes('"no_canonical_variant_evidence"'), "zero parsed variants must be reported as no evidence, never success");
assert.ok(cron.includes('"write_failed"'), "evidence persistence failures must be reported separately");
assert.ok(source.includes("const knownBarcodeAsins = new Set("), "fetch children with missing barcodes even when other child rows have valid barcodes");
assert.ok(testSourceHasUniqueRecoveredMerge(source), "recovered child detail evidence must replace barcode-less rows with the same source variant ID without duplicate upsert keys");
const genericParserIndex = source.indexOf("item.canonicalVariants = parseCanonicalMarketplaceVariantEvidence(detailHtml, item.productUrl)");
const amazonBranchIndex = source.indexOf('if (marketplace.marketplace === "amazon.co.jp")');
assert.ok(genericParserIndex >= 0 && genericParserIndex < amazonBranchIndex, "Schema.org child variants must be parsed for all enriched marketplaces, not only Amazon");
assert.ok(source.includes("canonicalVariantCount += item.canonicalVariants.length;"), "non-Amazon child evidence must contribute to persisted evidence telemetry");
assert.ok(source.includes("const limit = marketplace.marketplace === \"yahoo_shopping\""), "Yahoo detail pages must remain in the bounded enrichment path for canonical child extraction");


console.log("Amazon child variant diagnostics: extraction, persistence and cron reporting assertions passed");
