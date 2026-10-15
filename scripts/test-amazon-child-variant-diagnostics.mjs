import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const cron = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const requiredSignals = ["variationAsinsFound","childDetailAttempted","childDetailFetched","childBarcodeFound"];
for (const signal of requiredSignals) assert.ok(source.includes(signal), `missing diagnostic signal: ${signal}`);
assert.ok(source.indexOf("if (!jan && !gtin && !ean && !upc) return null;") < source.indexOf("childBarcodeFound += 1;"), "barcode count must follow concrete barcode validation");
assert.ok(source.includes("childDetailAttempted += childAsinsToFetch.length;"), "count only child detail pages actually scheduled for fetch");
assert.ok(source.includes("const knownBarcodeAsins = new Set("), "skip child pages only when existing child evidence already has a concrete barcode");
assert.ok(source.includes("const childAsinsToFetch = childAsins.filter((child) => !knownBarcodeAsins.has(child.asin));"), "fetch a child page when its ProductGroup node exists but lacks a barcode");
assert.ok(source.includes("child_detail_page: child.rawEvidence"), "attach independent child-page barcode provenance to an existing ProductGroup row");
assert.ok(source.includes("...Array.from(recoveredByAsin.values()).filter((child) => !recoveredAsins.has(child.asin))"), "append only recovered ASINs not already represented by canonical evidence");
assert.ok(source.includes("childDetailFetched += 1;"), "count successful detail fetches");
assert.ok(source.includes("parseAmazonVariationAsinMap(html, url).length > 0"), "Bright Data HTML with an explicit child-ASIN map must count as variant evidence");
assert.ok(source.includes("hasAmazonVariantEvidence(page.html)"), "retain Bright Data page when it improves child-variant evidence");
for (const signal of ["canonicalVariantEvidenceParsed", "canonicalVariantEvidenceWritten", "canonicalVariantEvidenceWriteFailures", "canonicalVariantEvidenceStatus"]) {
  assert.ok(cron.includes(signal), `market-sourcing cron must expose ${signal}`);
}
assert.ok(cron.includes('"no_canonical_variant_evidence"'), "zero parsed variants must be reported as no evidence, never success");
assert.ok(cron.includes('"write_failed"'), "evidence persistence failures must be reported separately");
console.log("Amazon child variant diagnostics: extraction, persistence and cron reporting assertions passed");
