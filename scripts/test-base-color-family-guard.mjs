import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASE_VARIATION_IMAGE_BINDING, getBaseColorFamilyBlockedIds } from "../lib/channels/base-color-family.ts";

const rows = [
  { id: "red", supplierCode: "cj", supplierProductId: "supplier-family-1" },
  { id: "blue", supplierCode: "cj", supplierProductId: "supplier-family-1" },
  { id: "single", supplierCode: "cj", supplierProductId: "supplier-single" },
  { id: "blank-a", supplierCode: "cj", supplierProductId: null },
  { id: "blank-b", supplierCode: "cj", supplierProductId: null },
  { id: "merchant", supplierCode: "cj", supplierProductId: "supplier-family-2" },
  { id: "merchant-sibling", supplierCode: "cj", supplierProductId: "supplier-family-2" },
];
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds(rows, new Set(["merchant"]))].sort(),
  ["blue", "merchant-sibling", "red"],
);
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds([{ id: "one", supplierCode: "cj", supplierProductId: "exact-id" }])],
  [],
);
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds([
    { id: "cj-red", supplierCode: "cj", supplierProductId: "same-id" },
    { id: "cj-blue", supplierCode: "cj", supplierProductId: "same-id" },
    { id: "other", supplierCode: "other-supplier", supplierProductId: "same-id" },
  ])].sort(),
  ["cj-blue", "cj-red"],
  "different supplier namespaces must never be grouped as one color family",
);
assert.equal(BASE_VARIATION_IMAGE_BINDING, "item_gallery_only");
const baseClient = readFileSync(new URL("../lib/channels/base.ts", import.meta.url), "utf8");
assert.match(baseClient, /variation\[\$\{index\}\]/, "BASE item creation must support exact color variations");
assert.match(baseClient, /variation_id\[\$\{index\}\]/, "BASE item edits must retain exact variation IDs");
const imageInput = baseClient.slice(baseClient.indexOf("export async function addBaseItemImage"));
assert.match(imageInput, /image_no/);
assert.doesNotMatch(imageInput.slice(0, 700), /variation_id/);
const migration = readFileSync(new URL("../app/api/internal/base-color-family-migrate/route.ts", import.meta.url), "utf8");
assert.match(migration, /variationImageIdentityVerified !== true/, "unverified supplier images must block BASE color migration");
assert.match(migration, /colorImageVerified !== true/, "unverified color images must block BASE color migration");
assert.match(migration, /variation_identifier/, "BASE variation identifiers must preserve exact supplier variant IDs");
assert.match(migration, /channel_listing_external_aliases/, "old BASE item IDs must remain mapped for historical orders");
const orderRoute = readFileSync(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
assert.match(orderRoute, /external_variant_id/);
assert.match(orderRoute, /channel_listing_external_aliases/);
assert.match(orderRoute, /item\.variation_id/);
assert.doesNotMatch(orderRoute.slice(orderRoute.indexOf("const { data: directListing"), orderRoute.indexOf("let listing = directListing")), /\.eq\("status", "published"\)/, "historical paid orders must still map after a listing is hidden");
const commercePublisher = readFileSync(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
assert.match(commercePublisher, /status: listing\.status === "published" \? "published" : "pending"/, "healthy grouped BASE listings must remain orderable");
assert.match(commercePublisher, /base_unpublish_variation_stock_readback_mismatch/, "a stale color must zero only its exact BASE variation");
assert.match(commercePublisher, /base_unfulfillable_variation_stock_readback_mismatch/, "an unfulfillable color must not hide its sibling variations");
assert.match(commercePublisher, /base_color_family_shared_price_mismatch/, "shared BASE price must be identical across all colors");
assert.match(commercePublisher, /base_color_family_variant_identity_mismatch/, "stock sync must preserve exact BASE variation IDs");
assert.match(commercePublisher, /state\.external_variant_id !== state\.external_product_id/, "scheduled BASE sync must revisit grouped color variants");
console.log("BASE color-family publication guard: 4 scenarios passed");
