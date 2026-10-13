import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifySalesTestGateInvariants } from "../lib/market/sales-test-gate.ts";
import { verifyWomenPriorityInvariants } from "../lib/intelligence/womens-priority.ts";
import { isPublishableCatalogTitle } from "../lib/catalog/publishable-title.ts";
import { resolveSupplyShippingPolicy } from "../lib/market/supply-shipping-policy.ts";

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
const [profit, supplySelector, marketSelector, publicationRoute, diagnosticWorkflow] = await Promise.all([
  readFile(new URL("../lib/intelligence/simulate-profit.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/sales-test-publication/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/tracer-shopify-auth-check.yml", import.meta.url), "utf8"),
]);
assert.match(profit, /requireDomesticShipping === true && args\.domesticShipping == null/);
assert.match(profit, /unknown\("domestic_shipping_unknown"\)/);
// Domestic shipping stays mandatory except for the approved CJ direct-to-Japan
// route (supplier=cj, ship_to=JP, positive freight, supplier and shipping verified).
assert.match(supplySelector, /requireDomesticShipping: shippingPolicy\.requireDomesticShipping/);
assert.match(supplySelector, /domesticShipping: shippingPolicy\.domesticShipping/);
const verifiedCj = { supplier: "cj", shipTo: "JP", shippingCost: 4.18, verificationStatus: "verified", shippingStatus: "verified" };
assert.deepEqual(resolveSupplyShippingPolicy(verifiedCj), { domesticShipping: 0, requireDomesticShipping: false, directToJapanShippingConfirmed: true });
for (const blocked of [
  { ...verifiedCj, supplier: "orosy" },
  { ...verifiedCj, shipTo: "US" },
  { ...verifiedCj, shippingCost: 0 },
  { ...verifiedCj, shippingCost: null },
  { ...verifiedCj, verificationStatus: "unverified" },
  { ...verifiedCj, shippingStatus: "unknown" },
]) {
  assert.deepEqual(resolveSupplyShippingPolicy(blocked), { domesticShipping: null, requireDomesticShipping: true, directToJapanShippingConfirmed: false });
}
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
console.log("fully costed publication, product-master, and 450-candidate audit guards: 27 assertions passed");
