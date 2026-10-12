import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const persist = await readFile(new URL("../lib/market/persist-bestsellers.ts", import.meta.url), "utf8");
const patrol = await readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8");
for (const signal of ["variationAsinsFound", "childDetailAttempted", "childDetailFetched", "childBarcodeFound"]) {
  assert.ok(persist.includes(signal), `persist result must expose ${signal}`);
  assert.ok(patrol.includes(signal), `patrol summary must preserve ${signal}`);
}
assert.ok(patrol.includes('key === "enrichment" && Array.isArray(value)'), "patrol must summarize enrichment telemetry rather than only logging its array length");

const requiredSignals = ["variationAsinsFound","childDetailAttempted","childDetailFetched","childBarcodeFound"];
for (const signal of requiredSignals) assert.ok(source.includes(signal), `missing diagnostic signal: ${signal}`);
assert.ok(source.indexOf("if (!jan && !gtin && !ean && !upc) return null;") < source.indexOf("childBarcodeFound += 1;"), "barcode count must follow concrete barcode validation");
assert.ok(source.includes("childDetailAttempted += childAsins.length;"), "count child attempts before fetch");
assert.ok(source.includes("childDetailFetched += 1;"), "count successful detail fetches");
assert.ok(source.includes("parseAmazonVariationAsinMap(html, url).length > 0"), "Bright Data HTML with an explicit child-ASIN map must count as variant evidence");
assert.ok(source.includes("hasAmazonVariantEvidence(page.html)"), "retain Bright Data page when it improves child-variant evidence");
console.log("Amazon child variant diagnostics: 9 assertions passed");
