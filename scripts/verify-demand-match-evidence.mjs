// Demand match precision tests (pure logic, no DB, no network).
// Run: node --experimental-strip-types scripts/verify-demand-match-evidence.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildIdentifierIndex,
  canonicalGtin,
  canonicalModel,
  canonicalBrand,
  exactIdentityVariantCompatible,
  encodeLegacyRationale,
  isStrongDemandMatch,
  legacyMethodFor,
  persistDemandMatches,
  readObservationIdentifiers,
  resolveExactIdentity,
  resolveMatchMethod,
  variantsCompatible,
} from "../lib/intelligence/demand-match-evidence.ts";
import { classifySellability } from "../lib/intelligence/sellability.ts";
import { normalizeIdentifier, verifyIdentifierMatchInvariants } from "../lib/market/identifiers.ts";
import { supabaseWriteFailure, verifyCjIdentityReverifyPolicyInvariants } from "../lib/suppliers/cj-identity-reverify-policy.ts";
import { firstCJImageUrl, parseCJFreightOptions, parseCJStockData, parseCJUsdPrice } from "../lib/sources/cj/parse.ts";

const results = [];
const pending = [];
function test(group, name, fn) {
  const record = (ok, error) => results.push({ group, name, ok, error });
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      pending.push(out.then(() => record(true), (e) => record(false, e instanceof Error ? e.message : String(e))));
    } else record(true);
  } catch (error) {
    record(false, error instanceof Error ? error.message : String(error));
  }
}

test("CJ reverify source safety", "canonical identity is required before persisting reverify evidence", () => {
  const source = readFileSync(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
  assert.equal(source.includes("identity?.productId ?? String(row.product_id)"), false, "must not fall back to an existing product_id");
  assert.match(source, /supplierBrand, supplierIdentifiers:/, "MPN matching must receive supplier brand evidence");
  const holdBranch = source.indexOf("if (!identity) {");
  const persistCall = source.indexOf("await persistCjSupplyIntelligence(");
  assert.ok(holdBranch >= 0 && persistCall > holdBranch, "unmatched rows must be held before canonical persistence");
  assert.match(source, /failed to persist recovered CJ evidence/);
  assert.match(source, /failed to persist unmatched CJ evidence/);
  assert.ok(source.includes('.select("id")\n          .maybeSingle()'), "evidence updates must verify a returned row");
});

test("Supabase persistence failures", "database errors and missing returned rows are not treated as success", () => {
  assert.equal(supabaseWriteFailure("update listing", { message: "permission denied" }), "update listing failed: permission denied");
  assert.equal(supabaseWriteFailure("update listing", null, null, true), "update listing affected no row");
  assert.equal(supabaseWriteFailure("update listing", null, { id: "listing-1" }, true), null);
  assert.equal(supabaseWriteFailure("insert cron run", { message: "statement timeout" }), "insert cron run failed: statement timeout");
  assert.equal(supabaseWriteFailure("insert cron run", null), null);
});
test("CJ reverify source safety", "retry metadata and cron_runs persistence failures are surfaced", () => {
  const source = readFileSync(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
  assert.match(source, /failed to record retry state/);
  assert.match(source, /persist retry state/);
  assert.match(source, /persist cron_runs outcome/);
  assert.match(source, /identity reverify cursor lookup failed/);
});

test("CJ reverify integration contract", "recovery uses live CJ evidence, persists to supplier listing, and never promotes without unique identity", () => {
  const source = readFileSync(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
  const persistence = readFileSync(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8");
  assert.match(source, /fetchCJVariantByVid\(String\(row\.supplier_variant_id\)\)/, "variant evidence must be fetched by the recorded CJ vid");
  assert.match(source, /getCJProductDetail\(String\(row\.supplier_product_id\)\)/, "product image evidence must be fetched by recorded CJ pid");
  assert.match(source, /fetchCJVariantStock\(String\(row\.supplier_variant_id\)\)/, "stock evidence must use the exact CJ variant");
  assert.match(source, /calculateCJFreight\(String\(row\.supplier_variant_id\)/, "freight must use the exact CJ variant");
  assert.match(source, /String\(row\.currency \?\? ""\)\.toUpperCase\(\) === "USD"/, "CJ price and freight cannot be treated as USD without explicit stored currency");
  assert.match(source, /identity_hold_reason: "no_unique_marketplace_identifier_match"/);
  assert.match(source, /failed to persist unmatched CJ evidence/);
  assert.match(source, /recovered CJ evidence update affected no supplier listing row/);
  assert.match(source, /unmatched CJ evidence update affected no supplier listing row/);
  assert.match(source, /if \(!identity\) \{[\s\S]*?return \{ kind: "no_match"/, "identity miss must return before canonical persistence");
  assert.match(persistence, /hasUniqueMarketplaceIdentity\(matchesByProduct\.size\)/, "identity resolution must require exactly one canonical product");
  assert.match(persistence, /\.select\("id"\)\s*\.maybeSingle\(\)/, "supplier evidence update must return the affected row");
  assert.match(persistence, /CJ supplier evidence persistence failed/);
  assert.match(persistence, /CJ supplier evidence update affected no supplier listing row/, "zero-row update must fail instead of reporting recovery");
});

test("CJ API fixtures", "variant sellPrice is accepted only with explicit USD currency", () => {
  assert.equal(parseCJUsdPrice("12.34", "USD"), 12.34);
  assert.equal(parseCJUsdPrice(12.34, "usd"), 12.34);
  for (const currency of [null, undefined, "", "JPY", "CNY", "unknown"]) assert.equal(parseCJUsdPrice("12.34", currency), null, String(currency));
  for (const value of [null, undefined, "", "not-a-price", 0, -1, "NaN"]) assert.equal(parseCJUsdPrice(value, "USD"), null, String(value));
});
test("CJ API fixtures", "real zero stock differs from missing or malformed stock", () => {
  assert.equal(parseCJStockData([{ vid: "v-zero", storageNum: 0 }]), 0);
  assert.equal(parseCJStockData([{ vid: "v-stock", storageNum: 3 }, { vid: "v-zero", storageNum: 0 }]), 3);
  for (const value of [null, undefined, {}, [], [{ vid: "v-unknown" }], [{ storageNum: "unknown" }], -1, "-2"]) assert.equal(parseCJStockData(value), null, JSON.stringify(value));
});
test("CJ API fixtures", "freight selection compares all-in USD totals across multiple shipping methods", () => {
  const parsed = parseCJFreightOptions([
    { logisticName: "Slow Base Only", logisticPrice: 1.2, logisticAging: "10-20" },
    { logisticName: "Express", logisticPrice: 7.5, totalPostageFee: 8.1, logisticAging: "3-6" },
    { logisticName: "Economy", logisticPrice: 4.1, totalPostageFee: "5.25", logisticAging: "7-12" },
    { logisticName: "Malformed", logisticPrice: "n/a", totalPostageFee: null },
    { logisticName: "", logisticPrice: 0.2 },
  ]);
  assert.deepEqual(parsed.map(({ logisticName, shippingCost, priceBasis }) => [logisticName, shippingCost, priceBasis]), [
    ["Economy", 5.25, "totalPostageFee"],
    ["Express", 8.1, "totalPostageFee"],
  ]);
  assert.equal(parsed[0].arrivalTime, "7-12");
});
test("CJ API fixtures", "freight falls back to logisticPrice only when no totalPostageFee exists", () => {
  const parsed = parseCJFreightOptions([
    { logisticName: "Carrier B", logisticPrice: "4.20" },
    { logisticName: "Carrier A", logisticPrice: 3.9 },
    { logisticName: "Bad", logisticPrice: "unknown" },
    null,
  ]);
  assert.deepEqual(parsed.map(({ logisticName, shippingCost, priceBasis }) => [logisticName, shippingCost, priceBasis]), [
    ["Carrier A", 3.9, "logisticPrice"],
    ["Carrier B", 4.2, "logisticPrice"],
  ]);
  assert.deepEqual(parseCJFreightOptions(null), []);
  assert.deepEqual(parseCJFreightOptions({ data: [] }), []);
});
test("CJ API fixtures", "CJ image candidates are retained only when non-empty and parseable", () => {
  assert.equal(firstCJImageUrl('["https://img.example/product.jpg","https://img.example/other.jpg"]'), "https://img.example/product.jpg");
  assert.equal(firstCJImageUrl(""), null);
  assert.equal(firstCJImageUrl("[malformed"), null);
});

test("marketplace identity", "identifier-only matching rejects title/image-only identity and validates barcodes", () => {
  const result = verifyIdentifierMatchInvariants();
  assert.equal(result.ok, true, result.cases.filter((item) => item.actual !== item.expected).map((item) => item.name).join(", "));
  assert.ok(result.cases.length >= 10);
});

test("CJ identity reverify policy", "retry intervals, candidate selection, raw GTIN audit, and unique-link gate", () => {
  const result = verifyCjIdentityReverifyPolicyInvariants();
  assert.equal(result.ok, true, result.cases.filter((item) => item.actual !== item.expected).map((item) => item.name).join(", "));
  assert.equal(result.cases.length >= 15, true);
  assert.equal(normalizeIdentifier("gtin", "1598446591114"), null);
  assert.equal(normalizeIdentifier("gtin", "4006381333931"), "4006381333931");
});

// Market product fixtures (JANs carry valid check digits).
const index = buildIdentifierIndex(
  [
    { product_id: "p-airpods", jan: "4549995433944", brand: "Apple", mpn: "MTJV3J/A" },
    { product_id: "p-sony-xm5", jan: "4548736132450", brand: "Sony", mpn: "WH-1000XM5" },
    { product_id: "p-anker", brand: "Anker", model: "A1263" },
    { product_id: "p-dup-1", brand: "Generic", mpn: "AB1234" },
    { product_id: "p-dup-2", brand: "Other", mpn: "AB1234" },
  ],
  [{ product_id: "p-ident", scheme: "gtin", value: "00012345678905" }],
);
const resolve = (metadata) => resolveExactIdentity(readObservationIdentifiers(metadata), index);

// The pre-#83 keyword rule (productMatchesQuery at e051a22), stored as
// match_method "keyword" score 0.9 and used by OI as product demand.
function beforeKeywordMatch(query, title) {
  const norm = (v) => v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(query), t = norm(title);
  if (!q || !t) return false;
  if (q === t) return true;
  const tokens = q.split(/[^\p{L}\p{N}]+/gu).filter((x) => x.length >= 2);
  if (tokens.length >= 2) return tokens.every((x) => t.includes(x));
  return false;
}
// After: title evidence is stored only as weak and only when variants agree.
function afterTitleDecision(query, title) {
  if (!beforeKeywordMatch(query, title)) return "no_match";
  return variantsCompatible(query, title).compatible ? "weak_only" : "variant_rejected";
}

// 1. exact JAN positive
test("exact JAN positive", "JAN matches exactly one product", () => {
  const d = resolve({ jan: "4549995433944" });
  assert.equal(d.status, "exact");
  assert.equal(d.productId, "p-airpods");
  assert.equal(d.method, "exact_jan");
  assert.equal(isStrongDemandMatch({ match_method: d.method }), true);
});
test("exact JAN positive", "UPC-A equals its GTIN-14 form", () => {
  assert.equal(canonicalGtin("012345678905"), canonicalGtin("00012345678905"));
  assert.equal(resolve({ upc: "012345678905" }).method, "exact_gtin");
});
test("exact identity variant gate", "exact JAN does not override a conflicting demand variant", () => {
  const d = resolve({ jan: "4549995433944" });
  assert.equal(d.status, "exact");
  assert.equal(variantsCompatible("AirPods Pro 2", "AirPods Pro").compatible, false);
  assert.equal(isStrongDemandMatch({ match_method: d.method }), true);
  // Matcher gate: the exact identifier is strong in isolation, but the
  // demand query/title contradiction must prevent it from being accepted.
  assert.equal(exactIdentityVariantCompatible("AirPods Pro 2", "AirPods Pro"), false);
  assert.equal(exactIdentityVariantCompatible("AirPods Pro", "AirPods Pro"), true);
});

// 2. JAN mismatch negative
test("JAN mismatch negative", "different valid JAN never matches", () => {
  assert.equal(resolve({ jan: "4901234567894" }).status, "none");
});
test("JAN mismatch negative", "bad check digit is not an identifier", () => {
  assert.equal(canonicalGtin("4549995433940"), null);
  assert.equal(resolve({ jan: "4549995433940" }).status, "none");
});
test("JAN mismatch negative", "non-barcode lengths rejected", () => {
  for (const v of ["12345", "454999543394", "45499954339440000", "ABC4549995433944"]) assert.equal(canonicalGtin(v), null, v);
});

// 3. exact model positive
test("exact model positive", "brand+model exact", () => {
  const d = resolve({ brand: "Sony", model: "WH-1000XM5" });
  assert.equal(d.status, "exact");
  assert.equal(d.method, "exact_brand_model");
  assert.equal(d.productId, "p-sony-xm5");
});
test("exact model positive", "model-only when observation has no brand", () => {
  const d = resolve({ model: "A1263" });
  assert.equal(d.status, "exact");
  assert.equal(d.method, "exact_model");
});

// 4. model generation mismatch negative
test("model generation mismatch negative", "WH-1000XM4 does not match WH-1000XM5", () => {
  assert.equal(resolve({ brand: "Sony", model: "WH-1000XM4" }).status, "none");
  assert.equal(resolve({ model: "WH1000XM4" }).status, "none");
});
test("model generation mismatch negative", "title: XM4 vs XM5 conflicts", () => {
  assert.equal(variantsCompatible("Sony WH-1000XM4", "Sony WH-1000XM5").compatible, false);
});

// 5. Galaxy S24 vs Galaxy S23 negative
test("Galaxy S24 vs S23 negative", "alphanumeric generation conflicts", () => {
  const v = variantsCompatible("Galaxy S24", "Galaxy S23");
  assert.equal(v.compatible, false);
  assert.ok(v.conflicts.some((c) => c.startsWith("model:")), v.conflicts.join(","));
});
test("Galaxy S24 vs S23 negative", "token rule already rejected S23 vs S24 (Before and After agree)", () => {
  assert.equal(beforeKeywordMatch("Galaxy S23 ケース", "galaxy s24 ケース 手帳型"), false);
  assert.equal(afterTitleDecision("Galaxy S23 ケース", "galaxy s24 ケース 手帳型"), "no_match");
});
test("Galaxy S24 vs S23 negative", "generation-less query vs S24 title: Before accepted, After rejects", () => {
  assert.equal(beforeKeywordMatch("Galaxy ケース", "galaxy s24 ケース"), true);
  assert.equal(afterTitleDecision("Galaxy ケース", "galaxy s24 ケース"), "variant_rejected");
  assert.equal(variantsCompatible("Galaxy S24 Ultra", "Galaxy S24").compatible, false);
});

// 6. brand mismatch negative
test("brand mismatch negative", "same model, different brand -> brand_conflict", () => {
  assert.equal(resolve({ brand: "Ugreen", model: "A1263" }).status, "brand_conflict");
});
test("brand mismatch negative", "brand alone is never identity", () => {
  assert.equal(resolve({ brand: "Apple" }).status, "none");
  assert.equal(resolve({ brand: "Sony", query: "Sony ヘッドホン" }).status, "none");
});

// 7. variant mismatch negative (Before accepted all of these as keyword 0.9)
const variantCases = [
  ["iPhone 15 ケース", "iphone 15 pro ケース"],
  ["iPhone 15 Pro", "iphone 15 pro max"],
  ["AirPods Pro", "airpods pro 2 第2世代"],
  ["Galaxy S24", "galaxy s24 ultra"],
  ["モバイルバッテリー 10000mAh", "モバイルバッテリー 10000mah 20w"],
  ["SSD 1TB", "ssd 1tb 2個セット 2pack"],
];
for (const [q, t] of variantCases) {
  test("variant mismatch negative", `"${q}" vs "${t}"`, () => {
    assert.equal(beforeKeywordMatch(q, t), true, "before should have accepted");
    assert.equal(afterTitleDecision(q, t), "variant_rejected");
  });
}

// 8. title-only similarity never becomes strong identity
test("title-only not strong", "exact same title is still weak", () => {
  assert.equal(afterTitleDecision("AirPods Pro", "airpods pro"), "weak_only");
  for (const m of ["normalized_title", "weak_text_similarity", "search_provenance", "keyword", "semantic", "category", "brand", "supplier_demand_evidence"]) {
    assert.equal(isStrongDemandMatch({ match_method: m, rationale: "x" }), false, m);
  }
});
test("title-only not strong", "legacy 'manual' column without evidence tag is weak", () => {
  assert.equal(isStrongDemandMatch({ match_method: "manual", rationale: "hand typed" }), false);
});

// 9. Japanese/English & width normalization (only provably safe forms)
test("JP/EN normalization", "full-width JAN with hyphen/space", () => {
  assert.equal(resolve({ jan: "４５４９９９５-４３３９４４ " }).productId, "p-airpods");
});
test("JP/EN normalization", "full-width / case / hyphen model", () => {
  assert.equal(canonicalModel("ｗｈ－１０００ｘｍ５"), canonicalModel("WH1000XM5"));
  assert.equal(resolve({ brand: "ＳＯＮＹ", model: "ｗｈ１０００ｘｍ５" }).productId, "p-sony-xm5");
});
test("JP/EN normalization", "full-width title variant is compatible", () => {
  assert.equal(variantsCompatible("iPhone 15 ケース", "ｉＰｈｏｎｅ　１５　ケース").compatible, true);
});
test("JP/EN normalization", "katakana brand is NOT equated with Latin brand (no unsafe transliteration)", () => {
  assert.notEqual(canonicalBrand("ソニー"), canonicalBrand("Sony"));
});

// 10. generic search term
test("generic search term", "generic words are not model numbers", () => {
  for (const v of ["airpods", "ケース", "イヤホン", "2024", "15", "s"]) assert.equal(canonicalModel(v), null, v);
});
test("generic search term", "generic query has no identity", () => {
  assert.equal(resolve({ query: "ワイヤレスイヤホン" }).status, "none");
});

// 11. multiple candidate ambiguity
test("multiple candidates", "one model -> two products is ambiguous", () => {
  const d = resolve({ model: "AB-1234" });
  assert.equal(d.status, "ambiguous");
  assert.deepEqual([...d.candidates].sort(), ["p-dup-1", "p-dup-2"]);
});
test("multiple candidates", "one JAN -> two products is ambiguous", () => {
  const dup = buildIdentifierIndex([{ product_id: "a", jan: "4549995433944" }, { product_id: "b", jan: "4549995433944" }], []);
  assert.equal(resolveExactIdentity(readObservationIdentifiers({ jan: "4549995433944" }), dup).status, "ambiguous");
});

// 12. no candidate
test("no candidate", "no identifiers at all", () => {
  assert.equal(resolve({}).status, "none");
  assert.equal(resolve({ query: "天気" }).status, "none");
});
test("no candidate", "empty index", () => {
  assert.equal(resolveExactIdentity(readObservationIdentifiers({ jan: "4549995433944" }), buildIdentifierIndex([], [])).status, "none");
});

// 13. evidence persistence (fake client reproducing production schema states)
function fakeDb(behaviour) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        upsert(rows, options) {
          calls.push({ table, rows, options });
          return Promise.resolve({ error: behaviour(rows, calls.length) });
        },
      };
    },
  };
}
const strongRow = { demandObservationId: "o1", productId: "p-airpods", score: 1, evidence: { method: "exact_jan", rationale: "JAN", facts: { gtin14: "04549995433944" }, sourceId: "o1" } };
const weakRow = { demandObservationId: "o2", productId: "p-x", score: 0.4, evidence: { method: "weak_text_similarity", rationale: "title", facts: {}, sourceId: "o2" } };
const LEGACY = new Set(["keyword", "category", "brand", "semantic", "manual"]);
// Legacy schema (20260920170000): CHECK on match_method, no evidence columns.
const legacySchema = (rows) =>
  rows.some((r) => "evidence" in r) ? { code: "PGRST204", message: "Could not find the 'evidence' column" }
    : rows.some((r) => !LEGACY.has(r.match_method)) ? { code: "23514", message: "violates check constraint" } : null;

test("evidence persistence", "migrated schema: evidence columns written", async () => {
  const db = fakeDb(() => null);
  const r = await persistDemandMatches(db, [strongRow, weakRow]);
  assert.deepEqual([r.written, r.schema, r.errors.length], [2, "evidence", 0]);
  assert.equal(db.calls[0].rows[0].match_method, "exact_jan");
  assert.equal(db.calls[0].rows[0].evidence_type, "identifier");
  assert.equal(db.calls[0].rows[1].evidence_type, "weak");
  assert.equal(db.calls[0].options.onConflict, "demand_observation_id,product_id");
});
test("evidence persistence", "legacy schema: falls back, CHECK-valid, evidence round-trips", async () => {
  const db = fakeDb(legacySchema);
  const r = await persistDemandMatches(db, [strongRow, weakRow]);
  assert.deepEqual([r.written, r.schema, r.errors.length], [2, "legacy", 0]);
  const [strong, weak] = db.calls[1].rows;
  assert.ok(LEGACY.has(strong.match_method) && LEGACY.has(weak.match_method));
  assert.equal(resolveMatchMethod(strong), "exact_jan");
  assert.equal(isStrongDemandMatch(strong), true);
  assert.equal(isStrongDemandMatch(weak), false);
});
test("evidence persistence", "Before: old row shape fails on the legacy schema", () => {
  const oldRow = { demand_observation_id: "o1", product_id: "p", match_method: "supplier_demand_evidence", match_score: 0.98, rationale: "x", evidence_type: "cj", source_id: "s", observed_at: "t" };
  assert.notEqual(legacySchema([oldRow]), null);
});
test("evidence persistence", "unrelated DB error is reported, not hidden, no blind fallback", async () => {
  const db = fakeDb(() => ({ code: "23503", message: "foreign key violation" }));
  const r = await persistDemandMatches(db, [strongRow]);
  assert.equal(r.written, 0);
  assert.equal(db.calls.length, 1);
  assert.match(r.errors[0], /23503/);
});
test("evidence persistence", "no rows -> no write", async () => {
  const db = fakeDb(() => null);
  assert.equal((await persistDemandMatches(db, [])).schema, "none");
  assert.equal(db.calls.length, 0);
});
test("evidence persistence", "weak evidence never encoded as a strong-looking legacy value", () => {
  assert.equal(legacyMethodFor("weak_text_similarity"), "keyword");
  assert.equal(legacyMethodFor("search_provenance"), "semantic");
  assert.equal(resolveMatchMethod({ match_method: "manual", rationale: encodeLegacyRationale(weakRow.evidence) }), "weak_text_similarity");
});

// TEST_READY gate: every missing proof keeps it out of TEST_READY.
const allTrue = {
  identityConfirmed: true, identityRejected: false, sourceOfferConfirmed: true, priceCurrencyReliable: true,
  supplyAvailable: true, shippingKnownOrExplicitUnknown: true, marketPriceAvailable: true, imageAvailable: true,
  marginCalculable: true, productPagePossible: true, creativePossible: true, returnRiskAccounted: true, demandSufficient: true,
};
test("gate", "all evidence present -> TEST_READY", () => assert.equal(classifySellability(allTrue).state, "TEST_READY"));
for (const key of ["identityConfirmed", "supplyAvailable", "demandSufficient", "shippingKnownOrExplicitUnknown", "returnRiskAccounted", "marginCalculable"]) {
  test("gate", `missing ${key} -> not TEST_READY`, () => assert.notEqual(classifySellability({ ...allTrue, [key]: false }).state, "TEST_READY"));
}

await Promise.all(pending);
let group = "";
for (const r of results.sort((a, b) => a.group.localeCompare(b.group))) {
  if (r.group !== group) { group = r.group; console.log(`\n[${group}]`); }
  console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` -> ${r.error}`}`);
}
const failed = results.filter((r) => !r.ok);
const before = variantCases.filter(([q, t]) => beforeKeywordMatch(q, t)).length;
const after = variantCases.filter(([q, t]) => afterTitleDecision(q, t) === "weak_only").length;
console.log(`\nBefore/After variant false positives accepted as demand: ${before}/${variantCases.length} -> ${after}/${variantCases.length}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
