import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const requiredSignals = ["variationAsinsFound","childDetailAttempted","childDetailFetched","childBarcodeFound"];
for (const signal of requiredSignals) assert.ok(source.includes(signal), `missing diagnostic signal: ${signal}`);
assert.ok(source.indexOf("if (!jan && !gtin && !ean && !upc) return null;") < source.indexOf("childBarcodeFound += 1;"), "barcode count must follow concrete barcode validation");
assert.ok(source.includes("childDetailAttempted += childAsins.length;"), "count child attempts before fetch");
assert.ok(source.includes("childDetailFetched += 1;"), "count successful detail fetches");
assert.ok(source.includes("fetchHtml(childUrl, { retryBrightDataWhenAmazonIdentifierMissing: true })"), "child detail pages must retry through Bright Data when direct HTML has no barcode");
assert.ok(source.includes("hasAmazonBarcodeEvidence"), "Bright Data child detail pages must be checked for their own barcode");
console.log("Amazon child variant diagnostics: 9 assertions passed");
