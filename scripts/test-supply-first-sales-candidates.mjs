import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pipeline = readFileSync("lib/intelligence/run-intelligence-pipeline.ts", "utf8");
const selector = readFileSync("lib/market/select-supply-sales-tests.ts", "utf8");
const identity = readFileSync("lib/catalog/canonical-supplier-identity.ts", "utf8");
const japaneseProduct = readFileSync("lib/intelligence/japanese-product.ts", "utf8");
const persistence = readFileSync("lib/intelligence/persist-cj-supply-intelligence.ts", "utf8");
const locators = readFileSync("lib/catalog/supplier-locators.ts", "utf8");

// The supply-first queue must not require a marketplace identity link: a
// standalone CJ catalog item can be sellable once its own exact variant and
// current supplier/economic evidence pass the native-CJ gate.
assert.match(pipeline, /\.eq\("verification_status",\s*"verified"\)/);
assert.match(pipeline, /\.eq\("shipping_status",\s*"verified"\)/);
assert.match(pipeline, /\.eq\("price_confirmed",\s*true\)/);
assert.match(pipeline, /\.eq\("inventory_confirmed",\s*true\)/);
assert.match(pipeline, /\.eq\("orderable",\s*true\)/);
assert.match(pipeline, /\.eq\("tracking_available",\s*true\)/);
assert.match(pipeline, /\.eq\("api_available",\s*true\)/);
assert.match(pipeline, /\.not\("supplier_product_id",\s*"is",\s*null\)/);
assert.match(pipeline, /\.not\("supplier_variant_id",\s*"is",\s*null\)/);
assert.match(pipeline, /\.gte\("last_verified_at",\s*freshSupplyCutoff\)/);
assert.match(pipeline, /selectAndPublishSupplySalesTests\(supplyCandidateIds,\s*50,\s*\{\s*allowNativeCjIdentity:\s*true\s*\}\)/, "native CJ publication must not depend on an unrelated feature flag");
assert.doesNotMatch(pipeline, /TRACER_CJ_NATIVE_SUPPLY_PUBLICATION_ENABLED/);
assert.match(selector, /options\.allowNativeCjIdentity\s*===\s*true/);
assert.match(selector, /isNativeCjSupplierListing\(candidate\)/);
assert.match(identity, /row\.verification_status === "verified"/);
assert.match(identity, /row\.shipping_status === "verified"/);
assert.match(identity, /row\.last_verified_at/);
assert.match(identity, /row\.supplier_product_id/);
assert.match(identity, /row\.supplier_variant_id/);
assert.match(selector, /Boolean\(candidate\.supplier_product_id\)/);
assert.match(selector, /Boolean\(candidate\.supplier_variant_id\)/);
assert.match(selector, /domesticShipping: nativeCjSupplyIdentity \? 0 : null/);
assert.match(selector, /!isPublishableCatalogTitle\(masterTitle\) && !nativeCjSupplyIdentity/);
assert.match(selector, /localizeProductDescription\(sourceTitle\)/);
assert.match(selector, /isPublishableCatalogDescription\(localizedDescription\)/);
assert.match(selector, /if \(!publishableDescription\)/);
// Candidate intelligence must survive unresolved marketplace identity. This is
// intentionally not the same as marking the offer orderable or publication-ready.
assert.match(persistence, /if \(!marketplaceIdentity\) \{/);
assert.match(persistence, /from\("product_intelligence"\)\.upsert\(/);
assert.match(persistence, /catalog_stage:\s*"candidate"/);
assert.match(persistence, /purchasable:\s*false/);
assert.match(persistence, /supplier_product_id:\s*args\.supplierProductId/);
assert.match(persistence, /supplier_variant_id:\s*args\.supplierVariantId/);
assert.match(persistence, /identity_status:\s*"supply_discovered"/);
assert.match(persistence, /marketplace identity is not confirmed, and order creation remains subject to order-time payment and fulfillment gates/);
assert.match(locators, /resolveSupplierCandidateProductId/);
assert.match(locators, /existingIdentityStatus === "supply_discovered" && existingProductId/);
assert.match(japaneseProduct, /knitted headband.*women/i);
assert.match(japaneseProduct, /柔らかなニット素材のクロスヘアバンドです/);

console.log("Supply-first candidate selection contract passed.");
