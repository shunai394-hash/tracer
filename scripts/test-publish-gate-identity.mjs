// Publication gate regression tests: identifiers, variants, supply and economics.
//
// Run: node --experimental-strip-types --no-warnings --import ./scripts/lib/register-ts-alias.mjs scripts/test-publish-gate-identity.mjs
//
// The end-to-end cases execute the real selectAndPublishSalesTests() /
// selectAndPublishSupplySalesTests() against an in-memory database (the
// Supabase admin client and FX lookup are replaced by test doubles through the
// module loader). A positive control proves the harness can reach
// published:true, so every negative case is a real rejection, not a harness gap.
import assert from "node:assert/strict";
import { createMemorySupabase } from "./lib/memory-supabase.mjs";

const { EMPTY_IDENTIFIERS, matchProductIdentity, hasExactMarketplaceVariantIdentifierMatch, identifierQueryEntries, normalizeIdentifier, isPublishGradeIdentityMethod } = await import("../lib/market/identifiers.ts");
const { canUseParentIdentityForSingleVariant, hasUniqueIdentitySelection, internalProductCandidateStatus } = await import("../lib/suppliers/cj-identity-reverify-policy.ts");
const { evaluateSalesTestGate } = await import("../lib/market/sales-test-gate.ts");
const { selectAndPublishSalesTests, publishCanonicalSalesTestListing } = await import("../lib/market/select-sales-tests.ts");
const { selectAndPublishSupplySalesTests } = await import("../lib/market/select-supply-sales-tests.ts");
const { shopifySyncBlockReasons } = await import("../lib/shopify/sync-published-listings.ts");
const { isInventoryRefreshTarget, decideInventoryRefresh } = await import("../lib/ops/inventory-refresh-policy.ts");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS", name);
  } catch (error) {
    failed += 1;
    console.error("FAIL", name, "\n ", error?.message ?? error);
  }
}

const id = (over) => ({ ...EMPTY_IDENTIFIERS, ...over });
const JAN = "4549995433944";
const JAN_OTHER = "4548736132450";
const ASIN = "B0TESTASIN";

// ---------------------------------------------------------------- identity
await test("JAN exact match is publish-grade", () => {
  const r = matchProductIdentity({ market: id({ jan: JAN }), supply: id({ jan: JAN }) });
  assert.equal(r.salesEligible, true);
  assert.equal(isPublishGradeIdentityMethod(r.method), true);
});
await test("JAN mismatch is a conflict, not a link", () => {
  const r = matchProductIdentity({ market: id({ jan: JAN }), supply: id({ jan: JAN_OTHER }) });
  assert.equal(r.linked, false);
  assert.equal(r.salesEligible, false);
});
await test("GTIN/EAN/UPC family matches after GTIN-14 normalisation", () => {
  assert.equal(matchProductIdentity({ market: id({ upc: "012345678905" }), supply: id({ gtin: "00012345678905" }) }).salesEligible, true);
  assert.equal(matchProductIdentity({ market: id({ jan: JAN }), supply: id({ ean: JAN }) }).salesEligible, true);
});
await test("UPC mismatch across schemes is rejected", () => {
  assert.equal(matchProductIdentity({ market: id({ upc: "012345678905" }), supply: id({ ean: JAN }) }).salesEligible, false);
});
await test("invalid supplier barcode (bad check digit) never matches", () => {
  assert.equal(normalizeIdentifier("gtin", "4549995433945"), null);
  const r = matchProductIdentity({ market: id({ jan: JAN }), supply: id({ gtin: normalizeIdentifier("gtin", "4549995433945") }) });
  assert.equal(r.salesEligible, false);
});
await test("missing supplier identifiers never match", () => {
  const r = matchProductIdentity({ market: id({ jan: JAN, asin: ASIN }), supply: id({}) });
  assert.equal(r.linked, false);
  assert.equal(r.salesEligible, false);
});
await test("brand + MPN match is publish-grade", () => {
  const r = matchProductIdentity({ market: { ...id({ mpn: "WH-1000XM5" }), brand: "Sony" }, supply: { ...id({ mpn: "WH-1000XM5" }), brand: "SONY " } });
  assert.equal(r.method, "brand_mpn");
  assert.equal(r.salesEligible, true);
});
await test("MPN match with a different brand is a conflict", () => {
  const r = matchProductIdentity({ market: { ...id({ mpn: "AB1234" }), brand: "Generic" }, supply: { ...id({ mpn: "AB1234" }), brand: "Other" } });
  assert.equal(r.linked, false);
  assert.equal(r.salesEligible, false);
});
await test("bare MPN without brand is a candidate only", () => {
  const r = matchProductIdentity({ market: id({ mpn: "AB1234" }), supply: id({ mpn: "AB1234" }) });
  assert.equal(r.salesEligible, false);
  assert.equal(isPublishGradeIdentityMethod(r.method), false);
});
await test("model generation difference (XM4 vs XM5) does not match", () => {
  const r = matchProductIdentity({ market: { ...id({ mpn: "WH-1000XM5" }), brand: "Sony" }, supply: { ...id({ mpn: "WH-1000XM4" }), brand: "Sony" } });
  assert.equal(r.salesEligible, false);
});
await test("ASIN-only match is a candidate, never sales-eligible", () => {
  const r = matchProductIdentity({ market: id({ asin: ASIN }), supply: id({ asin: ASIN }) });
  assert.equal(r.method, "asin");
  assert.equal(r.linked, true);
  assert.equal(r.salesEligible, false);
  assert.equal(isPublishGradeIdentityMethod("asin"), false);
});
await test("ASIN plus an independent barcode is eligible via the barcode", () => {
  const r = matchProductIdentity({ market: id({ asin: ASIN, jan: JAN }), supply: id({ asin: ASIN, jan: JAN }) });
  assert.equal(r.salesEligible, true);
  assert.equal(r.method, "jan");
});
await test("ASIN match cannot override a barcode conflict", () => {
  const r = matchProductIdentity({ market: id({ asin: ASIN, jan: JAN }), supply: id({ asin: ASIN, jan: JAN_OTHER }) });
  assert.equal(r.salesEligible, false);
  assert.equal(r.linked, false);
});
await test("ASIN still opens the investigation (query entry point)", () => {
  assert.deepEqual(identifierQueryEntries(id({ asin: ASIN })), [["asin", ASIN]]);
});

// ---------------------------------------------------------------- variants
await test("variant selection: ASIN alone is not exact variant evidence", () => {
  assert.equal(hasExactMarketplaceVariantIdentifierMatch(id({ asin: ASIN }), id({ asin: ASIN })), false);
  assert.equal(hasExactMarketplaceVariantIdentifierMatch(id({ jan: JAN }), id({ gtin: JAN })), true);
});
await test("parent ASIN/barcode is never inherited by a child variant", () => {
  for (const method of ["asin", "exact_asin", "jan", "gtin", "exact_gtin", "upc", "ean", "brand_mpn"]) {
    assert.equal(canUseParentIdentityForSingleVariant({ identityMethod: method, activeVariantCount: 1 }), false, method);
  }
});
await test("multiple / zero / ambiguous variant candidates are rejected", () => {
  assert.equal(hasUniqueIdentitySelection(0, 0), false);
  assert.equal(hasUniqueIdentitySelection(3, 0), false);
  assert.equal(hasUniqueIdentitySelection(3, 2), false);
  assert.equal(hasUniqueIdentitySelection(3, 1), true);
  assert.equal(internalProductCandidateStatus(0), "no_product_candidate");
  assert.equal(internalProductCandidateStatus(2), "ambiguous_product");
  assert.equal(internalProductCandidateStatus(Number.NaN), "ambiguous_product");
});

// ---------------------------------------------------------------- shared gate
function readyGate(over = {}) {
  return { rank: null, requireRank: false, title: "ワイヤレスイヤホン", sellingPrice: 5000, identityLinked: true, identityMethod: "jan", identityConfidence: 0.98, sourceCost: 1000, shippingCost: 300, trackingAvailable: true, apiAvailable: true, profitCalculable: true, shippingUnknown: false, contributionProfit: 2000, currencyMismatch: false, priceConfirmed: true, inventoryConfirmed: true, inventory: 10, orderable: true, supplierProductId: "P1", supplierVariantId: "V1", supplierCandidateCount: 1, ...over };
}
await test("shared gate: complete JAN evidence is eligible (control)", () => {
  assert.deepEqual(evaluateSalesTestGate(readyGate()), { eligible: true, reasons: [] });
});
for (const [name, over, reason] of [
  ["ASIN identity", { identityMethod: "asin" }, "identity_not_confirmed"],
  ["bare MPN identity", { identityMethod: "mpn" }, "identity_not_confirmed"],
  ["supply_discovered identity", { identityMethod: "supply_discovered" }, "identity_not_confirmed"],
  ["title identity", { identityMethod: "title" }, "identity_not_confirmed"],
  ["unlinked identity", { identityLinked: false }, "identity_not_confirmed"],
  ["low identity confidence", { identityConfidence: 0.5 }, "identity_confidence_low"],
  ["no supplier candidate", { supplierCandidateCount: 0 }, "supplier_candidate_missing"],
  ["multiple supplier candidates", { supplierCandidateCount: 2 }, "supplier_candidate_ambiguous"],
  ["missing supplier variant", { supplierVariantId: null }, "supplier_variant_unknown"],
  ["missing supplier product", { supplierProductId: null }, "supplier_product_unknown"],
  ["inventory unconfirmed", { inventoryConfirmed: false }, "inventory_unknown"],
  ["inventory zero", { inventory: 0 }, "inventory_zero"],
  ["inventory unknown", { inventory: null }, "inventory_zero"],
  ["price unconfirmed", { priceConfirmed: false }, "price_unconfirmed"],
  ["selling price unknown", { sellingPrice: null }, "selling_price_unknown"],
  ["source cost unknown", { sourceCost: null }, "source_cost_unknown"],
  ["shipping unknown", { shippingCost: null }, "shipping_unknown"],
  ["profit incalculable", { profitCalculable: false }, "profit_unknown"],
  ["profit not positive", { contributionProfit: -1 }, "profit_not_positive"],
  ["not orderable", { orderable: false }, "supplier_not_orderable"],
  ["supplier API unconfirmed", { apiAvailable: false }, "supplier_api_unknown"],
  ["tracking unavailable", { trackingAvailable: false }, "tracking_unknown"],
]) {
  await test(`shared gate rejects: ${name}`, () => {
    const r = evaluateSalesTestGate(readyGate(over));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.includes(reason), `expected ${reason}, got ${r.reasons.join(",")}`);
  });
}

// ---------------------------------------------------------------- end to end: market path
const BESTSELLER = { id: "b1", product_id: "prod-1", title: "ワイヤレスイヤホン ノイズキャンセリング", category: "electronics", image_url: "https://example.com/i.jpg", rank: 12, review_count: 40, price: 5000, currency: "JPY", source: "amazon_jp" };
const INTELLIGENCE = { product_id: "prod-1", demand_score: 70, search_fit_score: 60, market_gap_score: 50, competition_score: 40, creative_score: 30, selection_score: 65, overall_confidence: 0.8, selection_eligible: true, sellability_state: "TEST_READY", filter_state: "PASS", profit_state: "PROFIT_OK" };
const LISTING = { id: "sl-1", bestseller_id: "b1", product_id: "prod-1", supplier: "CJ", identity_status: "linked", identity_method: "jan", identity_confidence: 0.98, cost: 1000, shipping_cost: 300, currency: "JPY", tracking_available: true, api_available: true, orderable: true, inventory: 25, inventory_confirmed: true, price_confirmed: true, supplier_product_id: "P1", supplier_variant_id: "V1", external_id: "V1", created_at: "2026-10-10T00:00:00Z" };

async function runMarket({ listing = {}, listings, bestseller = {}, catalog, catalogVariant } = {}) {
  const db = createMemorySupabase({
    marketplace_bestsellers: [{ ...BESTSELLER, ...bestseller }],
    opportunity_intelligence: [INTELLIGENCE],
    supplier_listings: listings ?? [{ ...LISTING, ...listing }],
    tracer_supply_catalog: catalog ? [catalog] : [],
    tracer_supply_variants: catalogVariant ? [catalogVariant] : [],
    shop_listings: [],
  });
  globalThis.__TRACER_MEMORY_DB__ = db;
  const result = await selectAndPublishSalesTests(["b1"], 3);
  const published = db.table("shop_listings").filter((r) => r.published === true);
  return { db, result, published };
}

await test("E2E market control: JAN-linked, complete evidence reaches published:true", async () => {
  const { published, result } = await runMarket();
  assert.equal(result.published, 1, JSON.stringify(result.rejected));
  assert.equal(published.length, 1);
  assert.ok(published[0].selection_reasons.includes("sales_test_gate_passed"));
  assert.equal(published[0].pipeline_reason, "sales_test_gate_passed");
});
await test("E2E market control: brand+MPN-linked reaches published:true", async () => {
  const { published } = await runMarket({ listing: { identity_method: "brand_mpn", identity_confidence: 0.92 } });
  assert.equal(published.length, 1);
});
for (const [name, args, reason] of [
  ["ASIN-only link (confidence 0.99)", { listing: { identity_method: "asin", identity_confidence: 0.99 } }, "identity_not_confirmed"],
  ["bare MPN link", { listing: { identity_method: "mpn", identity_confidence: 0.88 } }, "identity_not_confirmed"],
  ["no linked supplier listing", { listings: [] }, "identity_not_confirmed"],
  ["two linked supplier variants (ambiguous)", { listings: [LISTING, { ...LISTING, id: "sl-2", supplier_variant_id: "V2", external_id: "V2" }] }, "supplier_candidate_ambiguous"],
  ["supplier variant id missing", { listing: { supplier_variant_id: null } }, "supplier_variant_unknown"],
  ["inventory unconfirmed", { listing: { inventory_confirmed: false } }, "inventory_unknown"],
  ["inventory zero", { listing: { inventory: 0 } }, "inventory_zero"],
  ["inventory unknown", { listing: { inventory: null } }, "inventory_zero"],
  ["price unconfirmed", { listing: { price_confirmed: false } }, "price_unconfirmed"],
  ["source cost unknown", { listing: { cost: null } }, "source_cost_unknown"],
  ["shipping unknown", { listing: { shipping_cost: null } }, "shipping_unknown"],
  ["negative profit", { listing: { cost: 9000 } }, "profit_not_positive"],
  ["supplier not orderable", { listing: { orderable: false } }, "supplier_not_orderable"],
  ["supplier API unconfirmed", { listing: { api_available: false } }, "supplier_api_unknown"],
  ["tracking unavailable", { listing: { tracking_available: false } }, "tracking_unknown"],
  ["market selling price unknown", { bestseller: { price: null } }, "selling_price_unknown"],
]) {
  await test(`E2E market rejects: ${name}`, async () => {
    const { published, result } = await runMarket(args);
    assert.equal(published.length, 0);
    const reasons = result.rejected.flatMap((r) => r.reasons);
    assert.ok(reasons.includes(reason), `expected ${reason}, got ${reasons.join(",")}`);
  });
}

// Internal supply: the catalog row is only as strong as the identifier that created it.
const CATALOG = { id: "cat-1", bestseller_id: "b1", orderable: true, status: "ready", updated_at: "2026-10-10T00:00:00Z", tracer_sku: "TRC-1", cost: 1000, shipping_cost: 300, handling_cost: 0, inventory: 30, tracking_available: true, currency: "JPY", sale_price: 5000, evidence: { identity_method: "jan", identity_confidence: 0.98, supply_product_id: "ip-1", supply_variant_id: "iv-1" } };
const CATALOG_VARIANT = { id: "cv-1", catalog_id: "cat-1", orderable: true, inventory: 30, updated_at: "2026-10-10T00:00:00Z", internal_supply_product_id: "ip-1", internal_supply_variant_id: "iv-1" };
await test("E2E internal control: JAN-evidenced catalog reaches published:true", async () => {
  const { published, result } = await runMarket({ listings: [], catalog: CATALOG, catalogVariant: CATALOG_VARIANT });
  assert.equal(published.length, 1, JSON.stringify(result.rejected));
});
await test("E2E internal rejects: catalog created from ASIN-only evidence", async () => {
  const { published } = await runMarket({ listings: [], catalog: { ...CATALOG, evidence: { ...CATALOG.evidence, identity_method: "asin", identity_confidence: 0.99 } }, catalogVariant: CATALOG_VARIANT });
  assert.equal(published.length, 0);
});
await test("E2E internal rejects: no orderable in-stock catalog variant", async () => {
  const { published, result } = await runMarket({ listings: [], catalog: CATALOG, catalogVariant: { ...CATALOG_VARIANT, inventory: 0 } });
  assert.equal(published.length, 0);
  assert.ok(result.rejected.flatMap((r) => r.reasons).includes("supplier_candidate_missing"));
});

// ---------------------------------------------------------------- end to end: supply path
async function runSupply(listingOver = {}, extraListings = []) {
  const db = createMemorySupabase({
    opportunity_intelligence: [{ ...INTELLIGENCE }],
    product_intelligence: [{ product_id: "prod-1", normalized_title: "ワイヤレスイヤホン ノイズキャンセリング", image_url: "https://example.com/i.jpg", currency: "JPY", current_price: 1000, metadata: { selling_price_jpy: 5000, category: "electronics" } }],
    supplier_listings: [{ ...LISTING, fetched_at: "2026-10-10T00:00:00Z", ...listingOver }, ...extraListings],
    shop_listings: [],
  });
  globalThis.__TRACER_MEMORY_DB__ = db;
  const result = await selectAndPublishSupplySalesTests(["prod-1"], 3);
  return { result, published: db.table("shop_listings").filter((r) => r.published === true) };
}
await test("E2E supply control: JAN-linked supply reaches published:true via the canonical writer", async () => {
  const { published, result } = await runSupply();
  assert.equal(published.length, 1, JSON.stringify(result.rejected));
  assert.ok(published[0].selection_reasons.includes("sales_test_gate:supply"));
});
for (const [name, over, extra] of [
  ["ASIN-only link", { identity_method: "asin", identity_confidence: 0.99 }],
  ["supply_discovered (not linked)", { identity_status: "supply_discovered", identity_method: "supply_discovered", identity_confidence: 0 }],
  ["inventory zero", { inventory: 0 }],
  ["price unconfirmed", { price_confirmed: false }],
  ["not orderable", { orderable: false }],
  ["two linked variants", {}, [{ ...LISTING, id: "sl-2", supplier_variant_id: "V2", fetched_at: "2026-10-09T00:00:00Z" }]],
]) {
  await test(`E2E supply rejects: ${name}`, async () => {
    const { published } = await runSupply(over, extra ?? []);
    assert.equal(published.length, 0);
  });
}

// ---------------------------------------------------------------- canonical writer
await test("canonical writer refuses an ASIN-only request even if the caller insists", async () => {
  const db = createMemorySupabase({ shop_listings: [] });
  const r = await publishCanonicalSalesTestListing(db, { gateInput: readyGate({ identityMethod: "asin", requireRank: false }), listing: { product_id: "x" }, slug: "x", selectionReasons: [], pipelineReason: "sales_test_gate_passed" });
  assert.equal(r.published, false);
  assert.equal(db.table("shop_listings").length, 0);
});

// ---------------------------------------------------------------- downstream separation
const PUBLISHED_ROW = { title: "ワイヤレスイヤホン", description: "ノイズキャンセリング機能を備え、通勤や移動中の音楽鑑賞に適したワイヤレスイヤホンです。", published: true, pipeline_stage: "PUBLISHED", pipeline_status: "published", selection_reasons: ["sales_test_gate_passed"], orderable: true, tracking_available: true, inventory: 5, currency: "JPY", supplier_name: "CJ", shipping_cost: 300, source_cost: 1000, contribution_profit: 2000, contribution_margin: 40 };
await test("Shopify sync delivers only rows already published by the gate", () => {
  assert.deepEqual(shopifySyncBlockReasons(PUBLISHED_ROW), []);
  assert.ok(shopifySyncBlockReasons({ ...PUBLISHED_ROW, published: false, pipeline_stage: "SELECTED", pipeline_status: "selected" }).includes("not_published_by_canonical_gate"));
  assert.ok(shopifySyncBlockReasons({ ...PUBLISHED_ROW, selection_reasons: [] }).includes("sales_test_gate_not_passed"));
});
await test("inventory-refresh targets only published, gate-passed rows (base_item_id alone is not enough)", () => {
  const row = { published: true, selection_reasons: ["sales_test_gate_passed"], supplier_name: "cj", supplier_variant_id: "V1" };
  assert.equal(isInventoryRefreshTarget(row), true);
  assert.equal(isInventoryRefreshTarget({ ...row, published: false, base_item_id: "999" }), false);
  assert.equal(isInventoryRefreshTarget({ ...row, selection_reasons: [], base_item_id: "999" }), false);
  assert.equal(isInventoryRefreshTarget({ ...row, supplier_variant_id: null }), false);
});
await test("inventory-refresh stops the sale whenever stock is not observed > 0", () => {
  for (const obs of [{ kind: "unavailable", reason: "supplier_not_configured" }, { kind: "observed", quantity: 0 }, { kind: "observed", quantity: Number.NaN }, { kind: "observed", quantity: -3 }]) {
    const d = decideInventoryRefresh(obs);
    assert.equal(d.orderable, false, JSON.stringify(obs));
    assert.equal(d.baseVisible, false);
    assert.equal(d.stopSale, true);
  }
  const ok = decideInventoryRefresh({ kind: "observed", quantity: 7.9 });
  assert.equal(ok.orderable, true);
  assert.equal(ok.baseStock, 7);
});

console.log(`Publish gate regression tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
