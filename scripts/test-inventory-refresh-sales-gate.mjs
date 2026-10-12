import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasDurableSalesTestGate } from "../lib/suppliers/inventory-refresh-gate.ts";

const marker = "sales_test_gate_passed";
const cases = [
  { name: "marker_present", input: [marker, "other"], expected: true },
  { name: "empty_reasons", input: [], expected: false },
  { name: "missing_reasons", input: null, expected: false },
  { name: "non_array_reasons", input: marker, expected: false },
  { name: "marker_removed_after_cost_change", input: ["other"], expected: false },
  { name: "wrong_marker", input: ["sales_test_gate_pending"], expected: false },
];
for (const item of cases) {
  assert.equal(hasDurableSalesTestGate(item.input), item.expected, item.name);
}
const persistence = readFileSync(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8");
assert.match(persistence, /price_checked_at:\s*null/, "cached or caller-provided CJ cost must not be stamped as a fresh price observation");
assert.doesNotMatch(persistence, /price_checked_at:\s*Number\.isFinite\(args\.cost\)/, "price freshness must not be inferred from cost validity alone");

const refreshRoute = readFileSync(new URL("../app/api/cron/inventory-refresh/route.ts", import.meta.url), "utf8");
assert.match(refreshRoute, /pipeline_reason:\s*"base_inventory_sync_failed"/, "BASE sync failures must be durably classified");
assert.match(refreshRoute, /published:\s*false,\s*orderable:\s*false/, "BASE sync failures must fail closed locally");
assert.match(refreshRoute, /visible:\s*false/, "BASE sync failures must attempt to hide the remote listing");
assert.match(refreshRoute, /hide retry failed:/, "failed BASE hide attempts must be recorded");
assert.match(refreshRoute, /from\("supplier_listings"\)[\s\S]{0,180}update\(\{ orderable: false, fetched_at: now \}\)/, "BASE sync failures must also block supplier-side eligibility");
assert.match(refreshRoute, /orderable:\s*orderable\s*&&\s*!deferBaseEligibility/, "BASE-backed listings must remain locally non-orderable while BASE sync is pending");
assert.match(refreshRoute, /restoreListingError[\s\S]{0,220}update\(\{ orderable: true, base_last_error: null \}\)/, "listing eligibility may be restored only after BASE sync succeeds");
assert.match(refreshRoute, /restoreSupplierError[\s\S]{0,220}update\(\{ orderable: true, fetched_at: now \}\)/, "supplier eligibility may be restored only after BASE sync succeeds");


const orosyImport = readFileSync(new URL("../app/api/cron/orosy-bulk-import/route.ts", import.meta.url), "utf8");
assert.match(orosyImport, /getOrosyShippingQuote/, "Orosy bulk import records a product-level quote for diagnostics");
assert.match(orosyImport, /variation\.currency\?\.trim\(\)\.toUpperCase\(\) !== "JPY"/, "JPY selling-price math requires an explicitly confirmed JPY supplier cost");
assert.match(orosyImport, /product-level quote is not sufficient evidence for this[\s\S]*exact variant/, "product-level shipping must not be promoted to variant-level evidence");
assert.match(orosyImport, /shipping_status:\s*"unknown"/, "product-level quote must not verify variant-level shipping");
assert.match(orosyImport, /shipping_checked_at:\s*null/, "variant-level shipping freshness must remain unset until exact-variant quote exists");
assert.match(orosyImport, /orderable:\s*false/, "Orosy import must not claim autonomous ordering while order creation/payment are unsupported");
const orosyAdapter = readFileSync(new URL("../lib/procurement/orosy-adapter.ts", import.meta.url), "utf8");
assert.match(orosyAdapter, /amount:\s*null,[\s\S]{0,100}currency:\s*null,[\s\S]{0,100}available:\s*null/, "indicative Orosy shipping must not be treated as confirmed landed cost");
assert.doesNotMatch(orosyAdapter, /currency:\s*(?:variation\.currency|detail\.currency|product\.currency)\s*\?\?\s*"JPY"/, "missing supplier currency must not be inferred as JPY");
assert.match(orosyImport, /tracking_available:\s*null/, "tracking must not be claimed without order lifecycle evidence");
assert.match(orosyImport, /contribution_profit:\s*null[\s\S]*contribution_margin:\s*null/, "profitability must remain unset until landed cost and Sales Test Gate are established");
assert.doesNotMatch(orosyImport, /selection_reasons:\s*\[[^\]]*"ORDERABLE"/, "candidate import must not stamp the orderable marker");


assert.doesNotMatch(orosyImport, /syncPublishedListingsToShopify/, "staging import must not trigger unrelated Shopify production sync");
assert.match(orosyImport, /staging_only_no_shopify_sync/, "import endpoint must explicitly report staging-only behavior");

console.log(`Inventory refresh sales-gate invariant: ${cases.length} cases passed; supplier price freshness: 2 assertions; BASE fail-closed: 8 assertions; Orosy import safety: 10 assertions`);
