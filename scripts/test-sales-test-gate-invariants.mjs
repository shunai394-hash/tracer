import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifySalesTestGateInvariants } from "../lib/market/sales-test-gate.ts";
import { verifyWomenPriorityInvariants } from "../lib/intelligence/womens-priority.ts";
import { isPublishableCatalogTitle } from "../lib/catalog/publishable-title.ts";

const checks = [
  ["sales test gate", verifySalesTestGateInvariants()],
  ["women's product priority", verifyWomenPriorityInvariants()],
];
for (const [name, result] of checks) {
  const failed = result.cases.filter((item) => item.actual !== item.expected);
  assert.equal(result.ok, true, `${name} invariants failed: ${JSON.stringify(failed)}`);
  console.log(`${name} invariants: ${result.cases.length} cases passed`);
}

// This script runs directly in Node before the Next build. Keep the profit
// guard check static because simulate-profit.ts uses a Next/TS path alias.
const [profit, supplySelector, marketSelector, publicationRoute, diagnosticWorkflow, supplyPersistence, internalSupplyPersistence] = await Promise.all([
  readFile(new URL("../lib/intelligence/simulate-profit.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/sales-test-publication/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/tracer-shopify-auth-check.yml", import.meta.url), "utf8"),
  readFile(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/suppliers/persist-cj-internal-supply.ts", import.meta.url), "utf8"),
]);
assert.match(profit, /requireDomesticShipping === true && args\.domesticShipping == null/);
assert.match(profit, /unknown\("domestic_shipping_unknown"\)/);
assert.match(supplySelector, /requireDomesticShipping: true/);
assert.match(supplySelector, /num\(metadata\.selling_price_jpy\)/, "only an explicitly confirmed selling_price_jpy can satisfy the publication selector");
assert.match(supplyPersistence, /suggested_selling_price_jpy: args\.sellingPriceJpy/, "heuristic CJ price must be stored as a suggestion, not a confirmed sale price");
assert.doesNotMatch(supplyPersistence, /selling_price_jpy: args\.sellingPriceJpy/, "CJ discovery must not write heuristic price as confirmed selling price");
assert.match(supplyPersistence, /const \{ selling_price_jpy: _legacyIntelligenceSellingPrice, \.\.\.intelligenceMetadataWithoutUnverifiedPrice \}/, "legacy heuristic sale price must be removed on refresh");
assert.match(internalSupplyPersistence, /suggested_selling_price_jpy: args\.sellingPriceJpy/, "internal supply price is also labeled as a suggestion");
assert.doesNotMatch(internalSupplyPersistence, /selling_price_jpy: args\.sellingPriceJpy/, "internal supply discovery must not present the heuristic as confirmed sale price");
assert.equal(isPublishableCatalogTitle("トレンド・seeded_dueアイテム"), false);
assert.equal(isPublishableCatalogTitle("Aroma Filter"), true);
assert.match(supplySelector, /product_master_title_not_publishable/);
assert.match(marketSelector, /requireDomesticShipping: true/);
assert.match(supplySelector, /rejectedCount: rejected\.length/);
assert.match(supplySelector, /rejectionCounts: summarizeRejections\(rejected\)/);
assert.match(supplySelector, /title: sourceTitle/);
assert.match(supplySelector, /contributionProfit: profit\.contributionProfit/);
assert.match(supplySelector, /const rejectedSamples = \[\.\.\.rejected\]\.sort/);
assert.match(publicationRoute, /Math\.min\(500, Math\.floor\(requestedDryRunLimit\)\)/);
assert.match(publicationRoute, /\.slice\(0, dryRunLimit\)/);
assert.match(diagnosticWorkflow, /sales-test-publication\?dryRun=true&limit=450/);
assert.match(diagnosticWorkflow, /rejectedSample.*\[:25\]/);
assert.match(diagnosticWorkflow, /rejectedSamples.*\[:25\]/);
console.log("fully costed publication, price provenance, product-master, and 450-candidate audit guards: 25 assertions passed");
