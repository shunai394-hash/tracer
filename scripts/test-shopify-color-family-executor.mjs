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
assert.match(executor, /mediaSrc: \[expectedDefault\.imageUrl\]/, "default color must receive its own image");
assert.match(executor, /mediaSrc: \[variant\.imageUrl\]/, "each added color must receive its own image");
assert.match(executor, /inventoryQuantities: \[\{ locationId, name: "available", quantity: variant\.inventory \}\]/, "variant stock must be written to the configured location");
assert.match(executor, /shopify_color_family_verification_variant_count_failed/, "final readback must verify exact variant count");
assert.match(executor, /shopify_color_family_verification_inventory_failed/, "final readback must verify inventory");
assert.match(executor, /shopify_color_family_verification_image_failed/, "final readback must verify image presence");
assert.doesNotMatch(executor, /ensureShopifyProductPublished|unpublishShopifyProduct|archive/i, "executor must not publish or archive source products");
console.log("Shopify color-family executor safety contract: 12 assertions passed");
