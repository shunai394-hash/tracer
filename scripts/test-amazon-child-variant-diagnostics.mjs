import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const requiredSignals = ["variationAsinsFound","childDetailAttempted","childDetailFetched","childBarcodeFound"];
for (const signal of requiredSignals) assert.ok(source.includes(signal), `missing diagnostic signal: ${signal}`);
assert.ok(source.indexOf("if (!jan && !gtin && !ean && !upc) return null;") < source.indexOf("childBarcodeFound += 1;"), "barcode count must follow concrete barcode validation");
assert.ok(source.includes("childDetailAttempted += childAsins.length;"), "count child attempts before fetch");
assert.ok(source.includes("childDetailFetched += 1;"), "count successful detail fetches");
console.log("Amazon child variant diagnostics: 7 assertions passed");
