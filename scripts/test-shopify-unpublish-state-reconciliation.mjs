import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sync = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const admin = await readFile(new URL("../lib/shopify/admin.ts", import.meta.url), "utf8");

// A failed publication removal must not be represented as internally unpublished.
const failureBlock = sync.slice(sync.indexOf("Shopify is still potentially published"), sync.indexOf("for (const row of candidates)"));
assert.match(failureBlock, /shopify_sync_status: "failed"/);
assert.match(failureBlock, /unpublish_failed:/);
assert.doesNotMatch(failureBlock, /published: false|pipeline_stage: "BLOCKED"|pipeline_status: "blocked"/);

// Successful external removal must be verified and then reconciled in the DB.
assert.match(admin, /shopify_unpublication_verification_failed/);
assert.match(sync, /await unpublishShopifyProduct\(String\(row\.shopify_product_id\)\)/);
assert.match(sync, /shopify_unpublished_but_internal_state_write_failed/);
assert.match(sync, /published: false/);
assert.match(sync, /pipeline_stage: "BLOCKED"/);
assert.match(sync, /pipeline_status: "blocked"/);
assert.match(sync, /published_at: null/);

// Include all Shopify-linked rows in the bounded reconciliation scan so drifted
// rows cannot evade unpublication merely because their internal state is mixed.
assert.match(sync, /shopify_product_id\.not\.is\.null"/);
assert.match(sync, /Eligible rows with drifted internal state must also be reconciled/);
assert.match(sync, /if \(row\.shopify_product_id\) return true/);

// Sale-stop causes must stay fail-closed.
for (const reason of [
  "inventory_zero_or_unknown",
  "supplier_identity_unlinked",
  "catalog_title_not_publishable",
  "catalog_description_not_publishable",
  "pipeline_blocked",
  "not_orderable",
  "tracking_unavailable",
  "profit_not_positive",
]) {
  assert.ok(sync.includes(reason), `missing block reason: ${reason}`);
}

// Shopify already unpublished is idempotent; API failures are not successes.
assert.match(admin, /if \(current\.product\.publishedOnPublication\)/);
assert.match(admin, /if \(verified\.product\?\.publishedOnPublication\) throw new Error\("shopify_unpublication_verification_failed"\)/);
assert.match(sync, /unpublish_failed:/);
assert.match(sync, /unpublish_failure_state_write_failed/);

console.log("Shopify unpublish state reconciliation source checks passed");
