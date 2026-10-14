import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
const checks = [
  ["supplier cost refresh uses exact variant ID", /fetchCJProductVariants\(String\(row\.supplier_product_id\), \{ countryCode: "JP" \}\)[\s\S]{0,300}variant\.vid === String\(row\.supplier_variant_id\)/],
  ["stock refresh uses exact supplier variant", /fetchCJVariantStock\(String\(row\.supplier_variant_id\)\)/],
  ["shipping refresh requests Japan freight for exact supplier variant", /calculateCJFreight\(String\(row\.supplier_variant_id\), \{ startCountryCode: "CN", endCountryCode: "JP", quantity: 1 \}\)/],
  ["image refresh reads supplier product detail", /getCJProductDetail\(String\(row\.supplier_product_id\)\)/],
  ["refreshed cost shipping and inventory persist to supplier listing", /\.update\(\{\s*cost, shipping_cost: shippingCost, inventory,/],
  ["missing fields are enumerated and queued for remediation", /remediation_missing_fields: missingFields[\s\S]{0,500}remediation_next_actions:/],
  ["successful refresh clears remediation fields", /remediation_status: "evidence_refreshed",[\s\S]{0,120}remediation_missing_fields: \[\]/],
  ["identity still requires exact supplier product and variant identifiers", /variant\.vid === String\(row\.supplier_variant_id\)/],
];
for (const [name, pattern] of checks) assert.match(source, pattern, name);
console.log(`CJ evidence remediation: ${checks.length} invariants passed`);
