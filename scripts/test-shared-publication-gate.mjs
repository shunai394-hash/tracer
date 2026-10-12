import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shopify = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const base = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");

// Preview and the real sync candidate selector must share the same gate.
assert.match(shopify, /const reasons = blockReasons\(row\);/, "preview must use canonical block reasons");
assert.match(shopify, /const candidates = rows\.filter\(\(row\) => blockReasons\(row\)\.length === 0\);/, "sync candidates must use canonical block reasons");
assert.match(shopify, /const blocked = rows\.filter\(\(row\) => !candidates\.includes\(row\)\);/, "rejected candidates must enter the blocked reconciliation path");
assert.match(shopify, /await unpublishShopifyProduct\(String\(row\.shopify_product_id\)\)/, "existing ineligible Shopify products must be unpublished");

// Required eligibility evidence must be enforced before a row becomes a candidate.
for (const reason of [
  "catalog_title_not_publishable",
  "catalog_description_not_publishable",
  "image_url_invalid",
  "selling_price_invalid",
  "supplier_product_missing",
  "supplier_variant_missing",
  "inventory_zero_or_unknown",
  "not_orderable",
  "tracking_unavailable",
  "supplier_identity_unlinked",
  "sales_test_gate_not_passed",
]) {
  assert.ok(shopify.includes(reason), `Shopify gate missing ${reason}`);
}
assert.match(shopify, /function hasValidHttpUrl\(value: unknown\)/, "Shopify image URL validation must parse URL, not just match a prefix");
assert.match(shopify, /parsed\.protocol === "http:" \|\| parsed\.protocol === "https:"/, "only HTTP(S) image URLs are accepted");

// BASE has separate channel-specific checks; retain and guard them rather than
// pretending supplier, sales-test, and fulfillment semantics are identical.
for (const reason of [
  "tracking_unavailable",
  "supplier_variant_identity_missing",
  "selling_price_invalid",
  "image_url_invalid",
  "shipping_unknown",
  "inventory_unknown",
  "supplier_not_orderable",
]) {
  assert.ok(base.includes(reason), `BASE publication guard missing ${reason}`);
}
assert.match(base, /if \(!validHttpUrl\(listing\.image_url\)\)/, "BASE must reject malformed image URLs");
assert.match(base, /if \(availableInventory === null \|\| !Number\.isFinite\(availableInventory\) \|\| availableInventory <= 0 \|\| listing\.orderable !== true\)/, "BASE must reject unknown/nonpositive stock and non-orderable supply");

// BASE hide failures must persist a retryable state; successful hides must not
// occupy every later limited batch, and OAuth failures must stop publication.
assert.match(base, /base_publication_status: "failed"/, "failed hides must be queryable for retry");
assert.match(base, /base_publication_status: "hidden"/, "successful hides must be marked reconciled");
assert.match(base, /base_publication_status\.eq\.failed/, "normal patrol must select failed hide attempts");
assert.match(base, /BASE_OAUTH_REFRESH_FAILED\|BASE_API_REQUEST_FAILED:HTTP_\(401\|403\)/, "actual BASE client auth error format must trigger auth stop");
assert.match(base, /if \(baseAuthBlocked\) \{\s*return \{/, "auth failure must stop the rest of the batch before publication");
assert.match(base, /base_hide_failed_state_persist_failed/, "DB failure while recording a hide failure must be surfaced");
assert.match(base, /base_hide_price_unknown/, "missing price must persist a retryable hide failure");

console.log("Publication gate source-contract checks passed (Shopify shared preview/sync gate; BASE channel-specific guards).");
