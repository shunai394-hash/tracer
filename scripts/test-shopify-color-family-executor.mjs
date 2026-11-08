import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/shopify/admin.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function createShopifyColorFamily");
assert.notEqual(start, -1, "guarded Shopify color-family executor must exist");
const executor = source.slice(start);

assert.match(executor, /SHOPIFY_COLOR_FAMILY_EXECUTION_ENABLED !== "1"/, "live execution must be opt-in");
assert.match(executor, /status: "DRAFT"/, "new family product must stay draft");
assert.match(executor, /productVariantsBulkUpdate/, "pre-created first option variant must be adopted, not duplicated");
assert.match(executor, /shopify_color_family_default_variant_color_mismatch/, "unexpected default color must fail closed");
assert.match(executor, /productVariantsBulkCreate/, "remaining color variants must be created in bulk");
assert.match(executor, /shopify_color_family_variant_image_ambiguous/, "duplicate image URLs must block color consolidation");
assert.match(executor, /!variant\.colorImageVerified/, "unverified color images must block Shopify draft creation");
assert.match(executor, /mediaSrc: \[expectedDefault\.imageUrl\]/, "default color must receive its own image");
assert.match(executor, /mediaSrc: \[variant\.imageUrl\]/, "each added color must receive its own image");
assert.match(executor, /key: "supplier_variant_id"/, "each color must retain its exact supplier variant identity");
assert.match(executor, /shopify_color_family_verification_supplier_variant_id_failed/, "final readback must verify supplier variant identity");
assert.match(executor, /inventoryQuantities: \[\{ locationId, name: "available", quantity: variant\.inventory \}\]/, "variant stock must be written to the configured location");
assert.match(executor, /shopify_color_family_verification_variant_count_failed/, "final readback must verify exact variant count");
assert.match(executor, /shopify_color_family_verification_inventory_failed/, "final readback must verify inventory");
assert.match(executor, /shopify_color_family_verification_image_failed/, "final readback must verify image presence");
assert.match(executor, /variantImages\.length !== 1/, "each color variant must have exactly one verified image");
assert.match(executor, /shopify_color_family_verification_color_image_mapping_failed/, "different colors must not share the same image asset");
assert.match(source, /canonicalVariantId: string/, "each source color must identify its canonical commerce variant");
assert.match(source, /sourceShopifyProductId: string/, "each source color must retain its old Shopify product ID");
assert.match(source, /sourceShopifyVariantId: string/, "each source color must retain its old Shopify variant ID");
assert.match(executor, /channel_listing_external_aliases/, "historical Shopify variant aliases must be persisted");
assert.match(executor, /shopify_color_family_alias_identity_conflict/, "conflicting historical aliases must fail closed");
assert.match(executor, /shopify_color_family_alias_verification_failed/, "persisted aliases must be read back and verified");
assert.doesNotMatch(executor, /ensureShopifyProductPublished|unpublishShopifyProduct|archive/i, "executor must not publish or archive source products");

assert.match(executor, /input\.inventoryLocationId\.trim\(\)/, "migration must use the location verified from the existing Shopify variants");
assert.match(source, /readShopifyVariantInventorySnapshot/, "migration must read current Shopify stock before creating the family");
assert.match(source, /activateShopifyProduct/, "verified draft family must be explicitly activated before publication");
assert.match(source, /status: product\.status as "DRAFT" \| "ACTIVE"/, "migration retries must remain idempotent after activation");
const migration = readFileSync(new URL("../app/api/internal/shopify-five-color-family-migrate/route.ts", import.meta.url), "utf8");
assert.match(migration, /2606090341151608200/, "migration must be pinned to the exact supplier product");
assert.match(migration, /variantImageIdentityVerified !== true/, "unverified exact-variant images must block migration");
assert.match(migration, /margin_rate\) < 0\.5/, "margin below 50 percent must block migration");
assert.match(migration, /offer\.ship_to !== "JP"/, "non-Japan supplier offers must block migration");
assert.match(migration, /ensureShopifyProductPublished\(created\.productId\)/, "new family must be published and verified before old products are unpublished");
assert.match(migration, /unpublishShopifyProduct\(oldProductId\)/, "only the five exact old Shopify products may be unpublished");
assert.match(migration, /channel_listing_update_failed/, "channel listing identity must be updated after successful migration");

console.log("Shopify color-family executor safety contract: migration and identity assertions passed");
