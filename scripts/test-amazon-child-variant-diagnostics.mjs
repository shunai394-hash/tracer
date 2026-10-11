import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const requiredSignals = [
  "variationAsinsFound",
  "childDetailAttempted",
  "childDetailFetched",
  "childBarcodeFound",
];
for (const signal of requiredSignals) {
  assert.ok(source.includes(signal), `missing bounded diagnostic signal: ${signal}`);
}
assert.ok(
  source.indexOf("if (!jan && !gtin && !ean && !upc) return null;") < source.indexOf("childBarcodeFound += 1;"),
  "child barcode counter must only increment after a concrete barcode is validated",
);
assert.ok(
  source.includes("childDetailAttempted += childAsins.length;"),
  "attempted child details must be counted before concurrent fetches",
);
assert.ok(
  source.includes("childDetailFetched += 1;"),
  "successful child detail fetches must be counted separately",
);
console.log("Amazon child variant diagnostics: 7 assertions passed");
