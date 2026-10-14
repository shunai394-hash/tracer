import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
const checks = [
  ["supplier cost refresh uses exact variant ID", /fetchCJProductVariants\(String\(row\.supplier_product_id\), \{ countryCode: "JP" \}\)[\s\S]{0,300}variant\.vid === String\(row\.supplier_variant_id\)/],
  ["stock refresh uses exact supplier variant", /fetchCJVariantStock\(String\(row\.supplier_variant_id\)\)/],
  ["shipping refresh requests Japan freight for exact supplier variant", /calculateCJFreight\(String\(row\.supplier_variant_id\), \{ startCountryCode: "CN", endCountryCode: "JP", quantity: 1 \}\)/],
  ["unknown freight uses a configurable JPY reserve instead of blocking the candidate", /TRACER_CJ_UNKNOWN_SHIPPING_RESERVE_JPY[\\s\\S]{0,500}evidence_type: "configurable_conservative_reserve"/],
  ["shipping reserve is included in landed-cost retail price recalculation", /shippingReserveApplied[\\s\\S]{0,500}calculatedRetailPriceJpy[\\s\\S]{0,200}sellingPriceJpy = shippingReserveApplied/],
  ["shipping estimate is explicitly recorded as estimated evidence", /estimated: true[\\s\\S]{0,500}shipping_estimate_applied: true/],
  ["image refresh reads supplier product detail", /getCJProductDetail\(String\(row\.supplier_product_id\)\)/],
  ["refreshed cost shipping and inventory persist to supplier listing", /\.update\(\{\s*cost, shipping_cost: shippingCost, inventory,/],
  ["missing fields are enumerated and queued for remediation", /remediation_missing_fields: missingFields[\s\S]{0,500}remediation_next_actions:/],
  ["successful refresh clears remediation fields", /remediation_status: "evidence_refreshed",[\s\S]{0,120}remediation_missing_fields: \[\]/],
  ["identity still requires exact supplier product and variant identifiers", /variant\.vid === String\(row\.supplier_variant_id\)/],
];
for (const [name, pattern] of checks) assert.match(source, pattern, name);
console.log(`CJ evidence remediation: ${checks.length} invariants passed`);
