import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifySalesTestGateInvariants, hasPassedSalesTestGate } from "../lib/market/sales-test-gate.ts";
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

// This script runs directly in Node before the Next build. Keep pricing and
// publication-gate contracts static because simulate-profit.ts uses a Next/TS path alias.
const [profit, supplySelector, marketSelector, publicationRoute, diagnosticWorkflow, shopifySync] = await Promise.all([
  readFile(new URL("../lib/intelligence/simulate-profit.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/sales-test-publication/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/tracer-shopify-auth-check.yml", import.meta.url), "utf8"),
  readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8"),
]);
assert.match(profit, /requireDomesticShipping === true && args\.domesticShipping == null/);
assert.match(profit, /unknown\("domestic_shipping_unknown"\)/);
assert.match(supplySelector, /domesticShipping: nativeCjSupplyIdentity \? 0 : null/);
assert.match(supplySelector, /requireDomesticShipping: !nativeCjSupplyIdentity/);
assert.equal(isPublishableCatalogTitle("トレンド・seeded_dueアイテム"), false);
assert.equal(isPublishableCatalogTitle("Aroma Filter"), true);
assert.match(supplySelector, /generic_non_merchandisable_title/);
assert.match(supplySelector, /profitCalculable: profit\.calculable/, "estimated CJ freight is included in landed-profit calculation");
assert.match(supplySelector, /shippingEstimated \? null : sellingPrice/, "estimated shipping forces landed-price recalculation");
assert.doesNotMatch(supplySelector, /if \(shippingEstimated\) reasons\.push\(/, "an estimated allowance must not itself reject a candidate; profitability is evaluated after allowance");
assert.match(supplySelector, /shippingCost: pricingShippingCost/, "the configured allowance must reach the shipping gate for profitability evaluation");
assert.match(supplySelector, /shippingUnknown: profit\.shippingUnknown/);
assert.match(marketSelector, /requireDomesticShipping: true/);
assert.match(marketSelector, /const supplierIdentity = \[/, "listing identity must use canonical supplier identifiers");
assert.match(marketSelector, /slugify\("supplier-item", supplierIdentity\)/, "listing slug must remain stable when the title changes");
assert.match(marketSelector, /\.eq\("supplier_name", supplierName\)[\s\S]*?\.eq\("supplier_product_id", supplierProductId\)[\s\S]*?\.eq\("supplier_variant_id", supplierVariantId\)/, "existing listings must be found by canonical supplier identity");
assert.match(marketSelector, /duplicate_canonical_supplier_identity_requires_review/, "ambiguous existing duplicates must be blocked for review");
assert.match(marketSelector, /supplier_identity_slug_conflict_requires_review/, "identity/slug conflicts must not overwrite another listing");

assert.match(supplySelector, /rejectedCount: rejected\.length/);
assert.match(supplySelector, /rejectionCounts: summarizeRejections\(rejected\)/);
assert.match(supplySelector, /title: sourceTitle/);
assert.match(supplySelector, /contributionProfit: profit\.contributionProfit/);
assert.match(marketSelector, /profit_not_positive/, "market-linked publication must reject a non-positive contribution profit");
assert.match(marketSelector, /if \(!profit\.calculable\) reasons\.push\("profit_unknown"\)/);
assert.match(shopifySync, /profit_not_positive/, "Shopify sync must reject a stored non-positive contribution profit");
assert.match(shopifySync, /reasons\.push\("profit_unknown"\)/);
assert.match(supplySelector, /const rejectedSamples = rejected\.slice\(0, 50\)/, "rejection samples must not prioritize a removed women-only gate");
assert.match(publicationRoute, /Math\.min\(500, Math\.floor\(requestedDryRunLimit\)\)/);
assert.match(publicationRoute, /\.slice\(0, dryRunLimit\)/);
assert.match(diagnosticWorkflow, /sales-test-publication\?dryRun=true&limit=450/);
assert.match(diagnosticWorkflow, /rejectedSample.*\[:25\]/);
assert.match(diagnosticWorkflow, /rejectedSamples.*\[:25\]/);
const gatePassedBeforeChannelFailure = {
  published: true,
  pipeline_stage: "BASE_PUBLICATION",
  pipeline_status: "failed",
  pipeline_reason: "base_publish_failed",
  selection_reasons: ["sales_test_gate_passed", "sales_test_gate:supply"],
  title: "低反発 トラベルネックピロー",
};
assert.equal(hasPassedSalesTestGate(gatePassedBeforeChannelFailure), true,
  "a BASE failure must not erase durable Sales Test Gate provenance for NEWFIND");
assert.equal(hasPassedSalesTestGate({ ...gatePassedBeforeChannelFailure, pipeline_stage: "BLOCKED" }), false,
  "explicitly blocked listings must not be delivered");
assert.ok(publicationRoute.indexOf("const newfind = await Promise.all") < publicationRoute.indexOf("const base = await publishPublishedListingsToBase"),
  "NEWFIND delivery must happen before BASE can mutate the pipeline status");
console.log("fully costed publication, product-master, and 450-candidate audit guards: 22 assertions passed");
