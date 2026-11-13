import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyCjIdentityReverifyPolicyInvariants } from "../lib/suppliers/cj-identity-reverify-policy.ts";

const source = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
const identitySource = await readFile(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8");
const checks = [
  ["stable supplier listing IDs and exact legacy tuples are queried before supplier-only rows", /select\("product_id,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id"\)[\s\S]{0,1200}partitionByExactShopListing/],
  ["reverification reuses the fresh barcode returned by the identity lookup", /const \{ identity, variantBarcode, variantDetails: freshVariantDetails \} = await resolveMarketplaceIdentityWithFreshBarcode/],
  ["reverification does not perform a duplicate CJ product-variant barcode lookup", /resolveMarketplaceIdentityWithFreshBarcode/],
  ["matched shop-listing suppliers are selected before supplier-only candidates", /const prioritizedRegularRows = \[\.\.\.matchedWomens, \.\.\.matchedOther, \.\.\.unmatchedWomens, \.\.\.unmatchedOther\]/],
  ["linked-first reverify selection stays inside the ascending cursor-safe batch", /const boundedRows = allRows[\s\\S]{0,180}\.slice\(0, limit\);[\s\\S]{0,400}prioritizedRegularRows\.filter\(\(row\) => boundedIds\.has/],
  ["cursor advances from the last ID in the complete bounded window, not processing order", /result\.nextCursor = String\(boundedRows\[boundedRows\.length - 1\]\.id\)/],
  ["reverification telemetry records exact shop-listing coverage", /exactShopListingCandidates: partition\.matched\.length[\s\S]{0,120}supplierOnlyCandidates: partition\.unmatched\.length/],
  ["exact CJ variant price is refreshed by variant ID", /fetchCJVariantByVid\(String\(row\.supplier_variant_id\)\)/],
  ["recovered price requires an exact live variant ID and valid returned parent ID", /const exactVariant = variantDetails\?\.vid === String\(row\.supplier_variant_id\)[\s\S]{0,180}variantDetails\?\.productId/],
  ["corrected live parent product ID retains an audit trail", /live_cj_product_id_corrected_at:[\s\S]{0,180}queryByVid_exact_vid_match/],
  ["currency is recovered only from an explicit stored source", /row\.currency \?\? metadata\.currency \?\? metadata\.source_currency/],
  ["recovered image must belong to the canonical live supplier product", /productDetails\?\.id === liveCanonicalSupplierProductId/],
  ["price recovery refuses to assume an unknown currency is USD", /if \(missingCost && currency === "USD"\)/],
  ["shipping recovery refuses to assume an unknown currency is USD", /if \(missingShipping && currency === "USD"\)/],
  ["unknown shipping status triggers a fresh freight quote even when an old cost exists", /const missingShipping = shippingCost === null \|\| row\.shipping_status !== "verified"/],
  ["only a fresh Japan freight quote promotes shipping status", /refreshedFields\.shipping_status = "verified"[\s\S]{0,100}refreshedFields\.ship_to = "JP"/],
  ["profit inputs require verified shipping evidence", /shippingQuoteVerified && fxRate !== null/],
  ["recovered supplier price is explicitly marked confirmed", /refreshedFields\.price_confirmed = true/],
  ["recovered supplier stock is explicitly marked confirmed", /refreshedFields\.inventory_confirmed = true/],
  ["fresh verified state requires a working order path", /const canMarkFreshVerified = priceVerified[\s\S]{0,600}row\.orderable === true/],
  ["fresh verification timestamp is persisted only after all prerequisites pass", /if \(canMarkFreshVerified\) \{[\s\S]{0,180}refreshedFields\.last_verified_at = checkedAt\.toISOString\(\)/],
  ["Japan-specific freight is requested for the exact variant", /calculateCJFreight\(String\(row\.supplier_variant_id\), \{ startCountryCode: "CN", endCountryCode: "JP", quantity: 1 \}\)/],
  ["variant stock is refreshed from the exact variant endpoint", /fetchCJVariantStock\(String\(row\.supplier_variant_id\)\)/],
  ["image recovery uses the canonical supplier product detail endpoint", /getCJProductDetail\(liveCanonicalSupplierProductId\)/],
  ["recovered values are persisted and write errors are checked", /from\("supplier_listings"\)\.update\(refreshedFields\)/],
  ["missing fields receive explicit repair actions and retry timestamps", /missing_supply_evidence_next_actions: nextActions[\s\S]{0,400}next_identity_reverify_at: nextRetryAt/],
  ["remediation is included in the cron response", /result\.remediationQueued\.push\(\{ supplierListingId: item\.supplierListingId, missingFields: item\.missingFields, nextActions: item\.nextActions \}\)/],
  ["incomplete evidence cannot flow into the canonical persistence step", /if \(!priceVerified \|\| cost === null \|\| shippingCost === null \|\| !shippingQuoteVerified \|\| !inventoryVerified \|\| inventory === null \|\| fxRate === null \|\| sellingPriceJpy === null \|\| !imageUrl\)/],
];
for (const [name, pattern] of checks) assert.match(source, pattern, name);
assert.match(identitySource, /const freshVariantBarcode = args\.variantBarcode\?\.trim\(\) \|\| null/, "CJ persistence must reuse the exact variant barcode supplied by live discovery, without an extra provider call");
assert.match(identitySource, /export async function resolveMarketplaceIdentityWithFreshBarcode/);
assert.match(identitySource, /fetchCJVariantByVid\(args\.supplierVariantId\)/, "read exact variant first to reuse SKU, cost and barcode in one CJ API request");
assert.ok(identitySource.indexOf("fetchCJVariantByVid(args.supplierVariantId)") < identitySource.indexOf("fetchCJProductVariants(args.supplierProductId"), "product-wide variant lookup is only a fallback");
assert.match(source, /variantDetails: freshVariantDetails/);
assert.match(source, /variantDetails = variantDetails \?\? await fetchCJVariantByVid/);
assert.match(identitySource, /const freshEvidence = await readSupplierBarcode\(args\)[\s\S]{0,180}resolveMarketplaceIdentityFromBarcode\(args, freshEvidence\.barcode\)/);
assert.doesNotMatch(source, /readPersistableBarcode|fetchCJProductVariants/, "one exact-variant lookup per row avoids duplicate CJ API quota consumption");
assert.match(identitySource, /variant_barcode: freshVariantBarcode/, "persisted metadata must retain the supplier-native variant barcode");
const persistBody = identitySource.slice(identitySource.indexOf("export async function persistCjSupplyIntelligence"));
assert.equal((persistBody.match(/resolveMarketplaceIdentityFromBarcode\(/g) ?? []).length, 0, "CJ supply persistence must not query marketplace identity tables");
assert.equal((persistBody.match(/readSupplierBarcode\(/g) ?? []).length, 0, "CJ supply persistence must not perform a redundant barcode lookup");

const policy = verifyCjIdentityReverifyPolicyInvariants();
assert.equal(policy.ok, true, JSON.stringify(policy.cases.filter((item) => item.actual !== item.expected)));
console.log(`CJ evidence recovery: ${checks.length} source invariants and policy invariants passed`);
