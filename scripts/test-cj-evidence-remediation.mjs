import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, migration] = await Promise.all([
  readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20261014110000_cj_estimated_shipping_status.sql", import.meta.url), "utf8"),
]);
const checks = [
  ["supplier cost refresh uses exact variant ID", /fetchCJProductVariants\(String\(row\.supplier_product_id\), \{ countryCode: "JP" \}\)[\s\S]{0,300}variant\.vid === String\(row\.supplier_variant_id\)/],
  ["stock refresh uses exact supplier variant", /fetchCJVariantStock\(String\(row\.supplier_variant_id\)\)/],
  ["shipping refresh requests Japan freight for exact supplier variant", /calculateCJFreight\(String\(row\.supplier_variant_id\), \{ startCountryCode: "CN", endCountryCode: "JP", quantity: 1 \}\)/],
  ["unknown freight uses a configurable JPY reserve instead of blocking the candidate", /TRACER_CJ_UNKNOWN_SHIPPING_RESERVE_JPY[\s\S]{0,1200}evidence_type: "configurable_conservative_reserve"/],
  ["shipping reserve is included in landed-cost retail price recalculation", /const shippingEstimated = shippingReserveApplied[\s\S]{0,1500}const calculatedRetailPriceJpy = [\s\S]{0,300}const sellingPriceJpy = shippingEstimated/],
  ["shipping estimate is explicitly recorded as estimated evidence", /estimated: true[\s\S]{0,200}checked_at: new Date\(\)\.toISOString\(\)/],
  ["shipping reserve policy is written to remediation metadata", /shipping_estimate_applied: true[\s\S]{0,200}shipping_estimate_policy: "TRACER_CJ_UNKNOWN_SHIPPING_RESERVE_JPY"/],
  ["estimated shipping status is persisted for the publication gate", /shipping_status: shippingEstimated \? "estimated" : "verified"/],
  ["a retry re-requests freight when previous shipping was estimated", /if \(shippingCost === null \|\| priorShippingEstimated \|\| row\.shipping_status !== "verified"\)[\s\S]{0,450}shippingQuoteObserved = true/],
  ["retail price is recalculated while freight is estimated", /const sellingPriceJpy = shippingEstimated[\s\S]{0,80}calculatedRetailPriceJpy/],
  ["image refresh reads supplier product detail", /getCJProductDetail\(String\(row\.supplier_product_id\)\)/],
  ["refreshed cost shipping and inventory persist to supplier listing", /\.update\(\{[\s\S]{0,180}cost, shipping_cost: shippingCost, shipping_status: shippingEstimated \? "estimated" : "verified", inventory,/],
  ["missing fields are enumerated and queued for remediation", /remediation_missing_fields: missingFields[\s\S]{0,500}remediation_next_actions:/],
  ["successful refresh clears remediation fields", /remediation_status: "evidence_refreshed",[\s\S]{0,120}remediation_missing_fields: \[\]/],
  ["identity still requires exact supplier product and variant identifiers", /variant\.vid === String\(row\.supplier_variant_id\)/],
];
for (const [name, pattern] of checks) assert.match(source, pattern, name);
assert.match(migration, /shipping_status IN \([\s\S]{0,120}estimated/, "database migration must permit estimated freight without calling it verified");
console.log(`CJ evidence remediation: ${checks.length} invariants passed`);
