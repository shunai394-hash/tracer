import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
const checks = [
  ["exact CJ variant price is refreshed by variant ID", /fetchCJVariantByVid\(String\(row\.supplier_variant_id\)\)/],
  ["recovered price requires both returned supplier IDs to match", /variantDetails\?\.vid === String\(row\.supplier_variant_id\)[\s\S]{0,180}variantDetails\.productId === String\(row\.supplier_product_id\)/],
  ["currency is recovered only from an explicit stored source", /row\.currency \?\? metadata\.currency \?\? metadata\.source_currency/],
  ["recovered image must belong to the exact supplier product", /productDetails\?\.id === String\(row\.supplier_product_id\)/],
  ["price recovery refuses to assume an unknown currency is USD", /if \(missingCost && currency === "USD"\)/],
  ["shipping recovery refuses to assume an unknown currency is USD", /if \(missingShipping && currency === "USD"\)/],
  ["unknown shipping status triggers a fresh freight quote even when an old cost exists", /const missingShipping = shippingCost === null \|\| row\.shipping_status !== "verified"/],
  ["only a fresh Japan freight quote promotes shipping status", /refreshedFields\.shipping_status = "verified"[\s\S]{0,100}refreshedFields\.ship_to = "JP"/],
  ["profit inputs require verified shipping evidence", /shippingQuoteVerified && fxRate !== null/],
  ["Japan-specific freight is requested for the exact variant", /calculateCJFreight\(String\(row\.supplier_variant_id\), \{ startCountryCode: "CN", endCountryCode: "JP", quantity: 1 \}\)/],
  ["variant stock is refreshed from the exact variant endpoint", /fetchCJVariantStock\(String\(row\.supplier_variant_id\)\)/],
  ["image recovery uses the supplier product detail endpoint", /getCJProductDetail\(String\(row\.supplier_product_id\)\)/],
  ["recovered values are persisted and write errors are checked", /from\("supplier_listings"\)\.update\(refreshedFields\)/],
  ["missing fields receive explicit repair actions and retry timestamps", /missing_supply_evidence_next_actions: nextActions[\s\S]{0,400}next_identity_reverify_at: nextRetryAt/],
  ["remediation is included in the cron response", /result\.remediationQueued\.push\(\{ supplierListingId: item\.supplierListingId, missingFields: item\.missingFields, nextActions: item\.nextActions \}\)/],
  ["incomplete evidence cannot flow into the canonical persistence step", /if \(cost === null \|\| shippingCost === null \|\| inventory === null \|\| fxRate === null \|\| sellingPriceJpy === null \|\| !imageUrl\)/],
];
for (const [name, pattern] of checks) assert.match(source, pattern, name);
console.log(`CJ evidence recovery: ${checks.length} invariants passed`);
