// Focused regression tests for exact supplier-variant identity proof.
// Run: node --experimental-strip-types --no-warnings scripts/verify-cj-variant-barcode-proof.mjs
import assert from "node:assert/strict";
import { exactVariantBarcodeMethod, hasUniqueCanonicalVariantMatch } from "../lib/market/variant-barcode-proof.ts";
import { readExactSupplierVariantBarcode } from "../lib/suppliers/cj-identity-reverify-policy.ts";
import { EMPTY_IDENTIFIERS, identifiersFromRecord, normalizeIdentifier } from "../lib/market/identifiers.ts";

const rows = [
  { vid: "parent-variant", barcode: "4006381333931" },
  { vid: "target-variant", barcode: "9991234567890" },
];
assert.equal(readExactSupplierVariantBarcode(rows, "target-variant"), "9991234567890");
assert.equal(readExactSupplierVariantBarcode(rows, "missing-variant"), null);
assert.equal(readExactSupplierVariantBarcode(rows, ""), null);
assert.equal(readExactSupplierVariantBarcode([{ vid: "target-variant", barcode: " " }], "target-variant"), null);
assert.equal(readExactSupplierVariantBarcode([
  { vid: "target-variant", barcode: "9991234567890" },
  { vid: "target-variant", barcode: "4006381333931" },
], "target-variant"), null);
assert.equal(readExactSupplierVariantBarcode([{ barcode: "9991234567890" }], "target-variant"), null);

const market = identifiersFromRecord({ gtin: "9991234567890" });
const exact = identifiersFromRecord({ gtin: "9991234567890" });
const wrong = identifiersFromRecord({ gtin: "4006381333931" });
const mpnOnly = { ...EMPTY_IDENTIFIERS, mpn: "MODEL-1" };
assert.notEqual(exactVariantBarcodeMethod(market, exact), null);
assert.equal(exactVariantBarcodeMethod(market, wrong), null);
assert.equal(exactVariantBarcodeMethod({ ...EMPTY_IDENTIFIERS, mpn: "MODEL-1" }, mpnOnly), null);
assert.equal(hasUniqueCanonicalVariantMatch(1, 1), true);
assert.equal(hasUniqueCanonicalVariantMatch(2, 1), false);
assert.equal(hasUniqueCanonicalVariantMatch(1, 2), false);
assert.equal(hasUniqueCanonicalVariantMatch(0, 0), false);
assert.equal(normalizeIdentifier("gtin", "1598446591114"), null);
assert.equal(normalizeIdentifier("gtin", "9991234567890"), "9991234567890");

console.log("PASS: exact CJ variant barcode, check digit, MPN-only rejection, and ambiguity gates");
