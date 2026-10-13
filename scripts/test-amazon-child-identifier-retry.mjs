import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");

assert.ok(
  source.includes("retryBrightDataWhenAmazonIdentifierMissing?: boolean"),
  "fetchHtml must support retrying when a child page lacks concrete barcode evidence",
);
assert.ok(
  source.includes("normalizeIdentifier(\"jan\", detail.jan)") &&
    source.includes("normalizeIdentifier(\"gtin\", detail.gtin)") &&
    source.includes("normalizeIdentifier(\"ean\", detail.ean)") &&
    source.includes("normalizeIdentifier(\"upc\", detail.upc)"),
  "Bright Data fallback must require a concrete barcode, not just non-empty HTML",
);
assert.ok(
  source.includes("const childHtml = await fetchHtml(childUrl, { retryBrightDataWhenAmazonIdentifierMissing: true });"),
  "Amazon child detail pages must request evidence-based Bright Data fallback",
);
console.log("PASS: Amazon child detail fetch retries when concrete barcode evidence is missing");
