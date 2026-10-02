// Demand match precision tests (pure logic, no DB, no network).
// Run: node --experimental-strip-types scripts/verify-demand-match-evidence.mjs
import assert from "node:assert/strict";
import {
  buildIdentifierIndex,
  canonicalGtin,
  canonicalModel,
  encodeLegacyRationale,
  isStrongDemandMatch,
  legacyMethodFor,
  readObservationIdentifiers,
  resolveExactIdentity,
  resolveMatchMethod,
  variantsCompatible,
} from "../lib/intelligence/demand-match-evidence.ts";
import { classifySellability } from "../lib/intelligence/sellability.ts";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// Market product fixtures: real-world style identifiers.
const index = buildIdentifierIndex(
  [
    { product_id: "p-airpods", jan: "4549995433944", brand: "Apple", mpn: "MTJV3J/A" },
    { product_id: "p-sony", jan: "4548736132450", brand: "Sony", mpn: "WH-1000XM5" },
    { product_id: "p-anker", brand: "Anker", model: "A1263" },
    // Two products sharing one model -> ambiguous.
    { product_id: "p-dup-1", brand: "Generic", mpn: "AB1234" },
    { product_id: "p-dup-2", brand: "Other", mpn: "AB1234" },
  ],
  [{ product_id: "p-ident", scheme: "gtin", value: "00012345678905" }],
);

// --- exact identifier: positive -------------------------------------------
test("exact JAN matches uniquely", () => {
  const d = resolveExactIdentity(readObservationIdentifiers({ jan: "4549995433944" }), index);
  assert.equal(d.status, "exact");
  assert.equal(d.productId, "p-airpods");
  assert.equal(d.method, "exact_jan");
});
test("JAN formatting (full-width, hyphen, space) normalizes to the same GTIN", () => {
  const d = resolveExactIdentity(readObservationIdentifiers({ jan: "４５４９９９５-４３３９４４ " }), index);
  assert.equal(d.status, "exact");
  assert.equal(d.productId, "p-airpods");
});
test("UPC-A equals its GTIN-14 form", () => {
  assert.equal(canonicalGtin("012345678905"), canonicalGtin("00012345678905"));
  const d = resolveExactIdentity(readObservationIdentifiers({ upc: "012345678905" }), index);
  assert.equal(d.status, "exact");
  assert.equal(d.method, "exact_gtin");
});
test("brand+model matches with hyphen/case/full-width differences", () => {
  const d = resolveExactIdentity(readObservationIdentifiers({ brand: "SONY", model: "ｗｈ１０００ｘｍ５" }), index);
  assert.equal(d.status, "exact");
  assert.equal(d.productId, "p-sony");
  assert.equal(d.method, "exact_brand_model");
});
test("model-only matches when observation has no brand", () => {
  const d = resolveExactIdentity(readObservationIdentifiers({ model: "a-1263" }), index);
  assert.equal(d.status, "exact");
  assert.equal(d.productId, "p-anker");
});

// --- exact identifier: negative -------------------------------------------
test("JAN with bad check digit is not an identifier", () => {
  assert.equal(canonicalGtin("4549995433941"), null);
  assert.equal(resolveExactIdentity(readObservationIdentifiers({ jan: "4549995433941" }), index).status, "none");
});
test("different JAN never matches", () => {
  assert.equal(resolveExactIdentity(readObservationIdentifiers({ jan: "4901234567894" }), index).status, "none");
});
test("brand mismatch on model-only hit is rejected", () => {
  const d = resolveExactIdentity(readObservationIdentifiers({ brand: "Ugreen", model: "A1263" }), index);
  assert.equal(d.status, "brand_conflict");
});
test("multiple candidates for one model are ambiguous, not matched", () => {
  const d = resolveExactIdentity(readObservationIdentifiers({ model: "AB-1234" }), index);
  assert.equal(d.status, "ambiguous");
  assert.equal(d.candidates.length, 2);
});
test("no identifiers -> no candidate", () => {
  assert.equal(resolveExactIdentity(readObservationIdentifiers({ query: "AirPods" }), index).status, "none");
});
test("generic keyword is not a model number", () => {
  assert.equal(canonicalModel("airpods"), null);
  assert.equal(canonicalModel("2024"), null);
  assert.equal(canonicalModel("15"), null);
});

// --- variants (title evidence) ---------------------------------------------
const variantPairs = [
  ["iPhone 15 ケース", "iPhone 15 Pro ケース", false],
  ["iPhone 15 Pro", "iPhone 15 Pro Max", false],
  ["iPhone 15", "iPhone 14", false],
  ["iPhone ケース", "iPhone 15 ケース", false],
  ["AirPods Pro", "AirPods", false],
  ["Galaxy S24 Ultra", "Galaxy S24", false],
  ["モバイルバッテリー 10000mAh", "モバイルバッテリー 20000mAh", false],
  ["SSD 1TB", "SSD 2TB", false],
  ["Galaxy S24", "Galaxy S23", false],
  ["MacBook Air M2", "MacBook Air M3", false],
  ["Sony WH-1000XM5", "Sony WH-1000XM4", false],
  ["モバイルバッテリー 10000mAh", "モバイルバッテリー 10000mah 大容量", true],
  ["iPhone 15 ケース", "ｉＰｈｏｎｅ　１５　ケース", true],
  ["AirPods Pro", "airpods pro", true],
];
for (const [a, b, expected] of variantPairs) {
  test(`variant ${expected ? "compatible" : "conflict"}: "${a}" vs "${b}"`, () => {
    assert.equal(variantsCompatible(a, b).compatible, expected);
  });
}

// --- evidence strength -----------------------------------------------------
test("title-only / search provenance / legacy rows are weak", () => {
  for (const method of ["normalized_title", "weak_text_similarity", "search_provenance", "keyword", "semantic", "manual", "brand", "category", "supplier_demand_evidence"]) {
    assert.equal(isStrongDemandMatch({ match_method: method, rationale: "x" }), false, method);
  }
});
test("legacy-encoded strong evidence round-trips; weak never reads as strong", () => {
  const strong = { method: "exact_jan", rationale: "r", facts: { gtin14: "x" }, sourceId: "o" };
  assert.equal(isStrongDemandMatch({ match_method: legacyMethodFor("exact_jan"), rationale: encodeLegacyRationale(strong) }), true);
  const weak = { ...strong, method: "weak_text_similarity" };
  assert.equal(resolveMatchMethod({ match_method: legacyMethodFor("weak_text_similarity"), rationale: encodeLegacyRationale(weak) }), "weak_text_similarity");
  assert.notEqual(legacyMethodFor("weak_text_similarity"), "manual");
});

// --- TEST_READY gate: any unknown keeps it VALIDATING ----------------------
const allTrue = {
  identityConfirmed: true, identityRejected: false, sourceOfferConfirmed: true, priceCurrencyReliable: true,
  supplyAvailable: true, shippingKnownOrExplicitUnknown: true, marketPriceAvailable: true, imageAvailable: true,
  marginCalculable: true, productPagePossible: true, creativePossible: true, returnRiskAccounted: true, demandSufficient: true,
};
test("all evidence present -> TEST_READY", () => {
  assert.equal(classifySellability(allTrue).state, "TEST_READY");
});
for (const key of ["identityConfirmed", "supplyAvailable", "demandSufficient", "shippingKnownOrExplicitUnknown", "returnRiskAccounted", "marginCalculable"]) {
  test(`missing ${key} -> not TEST_READY`, () => {
    assert.notEqual(classifySellability({ ...allTrue, [key]: false }).state, "TEST_READY");
  });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` -> ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
