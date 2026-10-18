import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyBaseIdentifier, decideCommerceSkuLink } from "../lib/channels/base-item-identity.ts";
import { classifyBaseMappingCounts } from "../lib/channels/base-mapping-audit.ts";
import { nextShopifyVendorPage, SHOPIFY_VENDOR_SCAN_MAX_PAGES } from "../lib/shopify/catalog-scan.ts";

const baseReadbackRoute = readFileSync(new URL("../app/api/cron/base-channel-external-readback/route.ts", import.meta.url), "utf8");
assert.ok(baseReadbackRoute.includes(String.raw`if (!/^\d+$/.test(baseItemId))`), "BASE readback must accept numeric external item IDs");
assert.equal(/^\d+$/.test("123456789"), true);
assert.equal(/^\d+$/.test("123abc"), false);

assert.ok(baseReadbackRoute.includes('String(item.identifier ?? "").trim()'), "BASE readback must inspect the actual BASE item identifier");
assert.ok(baseReadbackRoute.includes("expectedSku === externalSku"), "BASE readback must compare stored SKU with the actual BASE identifier");
assert.ok(baseReadbackRoute.includes("skuMismatches:"), "BASE readback summary must count SKU mismatches");
const baseReadbackWorkflow = readFileSync(new URL("../.github/workflows/base-external-readback-audit.yml", import.meta.url), "utf8");
assert.ok(baseReadbackWorkflow.includes("totals.skuMismatches > 0"), "full BASE audit must fail when actual SKU mismatches exist");
assert.ok(baseReadbackWorkflow.includes("expectedSku: row.expectedSku, externalSku: row.externalSku"), "BASE audit artifact must preserve expected and actual SKU evidence");

assert.deepEqual(classifyBaseMappingCounts(0, 0), { kind: "none" });
assert.deepEqual(classifyBaseMappingCounts(1, 0), { kind: "legacy" });
assert.deepEqual(classifyBaseMappingCounts(2, 0), { kind: "ambiguous" });
assert.deepEqual(classifyBaseMappingCounts(1, 1), { kind: "commerce" }, "one active commerce mapping must take precedence over a migrated legacy row");
assert.deepEqual(classifyBaseMappingCounts(3, 1), { kind: "commerce" }, "legacy migration leftovers must not shadow a unique active commerce mapping");
assert.deepEqual(classifyBaseMappingCounts(0, 2), { kind: "ambiguous" }, "duplicate active commerce mappings remain ambiguous");

assert.deepEqual(classifyBaseIdentifier(null), { kind: "missing" });
assert.deepEqual(classifyBaseIdentifier("  "), { kind: "missing" });
assert.deepEqual(classifyBaseIdentifier("plain-sku"), { kind: "other" });
assert.deepEqual(
  classifyBaseIdentifier("TRC-7a10656f-5907-47a9-a636-a174f3ebad63"),
  { kind: "legacy_uuid", listingId: "7a10656f-5907-47a9-a636-a174f3ebad63" },
);
assert.deepEqual(
  classifyBaseIdentifier("trc-3ce7d60edc484eae9d5e485a"),
  { kind: "commerce_sku", sku: "TRC-3CE7D60EDC484EAE9D5E485A" },
);

const listing = { id: "listing-1", externalProductId: null };
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [listing],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: [],
}).outcome, "repairable");
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [{ id: "listing-1", externalProductId: "100" }],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: ["listing-1"],
}).outcome, "already_linked");
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [{ id: "listing-1", externalProductId: "999" }],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: [],
}).outcome, "listing_has_different_base_item");
assert.deepEqual(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [{ id: "listing-1", externalProductId: "999" }],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: [],
  currentExternalIdExists: false,
}), {
  outcome: "repairable_stale_external_id",
  listingId: "listing-1",
  previousExternalProductId: "999",
});
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [{ id: "listing-1", externalProductId: "999" }],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: [],
  currentExternalIdExists: true,
}).outcome, "listing_has_different_base_item");
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [{ id: "listing-1", externalProductId: "999" }],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: ["other-listing"],
  currentExternalIdExists: false,
}).outcome, "base_item_already_mapped");
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [listing, { id: "listing-2", externalProductId: null }],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: [],
}).outcome, "ambiguous_sku");
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [listing],
  otherBaseItemIdsWithSameSku: ["200"],
  listingIdsAlreadyUsingBaseItem: [],
}).outcome, "ambiguous_base_item");
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: [],
}).outcome, "no_listing");
assert.equal(decideCommerceSkuLink({
  baseItemId: "100",
  listingsForSku: [listing],
  otherBaseItemIdsWithSameSku: [],
  listingIdsAlreadyUsingBaseItem: ["other-listing"],
}).outcome, "base_item_already_mapped");

assert.equal(SHOPIFY_VENDOR_SCAN_MAX_PAGES, 100);
assert.deepEqual(nextShopifyVendorPage({
  pageIndex: 0, maxPages: 100, hasNextPage: false, endCursor: null, previousCursor: null,
}), { action: "complete" });
assert.deepEqual(nextShopifyVendorPage({
  pageIndex: 7, maxPages: 8, hasNextPage: true, endCursor: "cursor-8", previousCursor: "cursor-7",
}), { action: "incomplete", reason: "page_cap" });
assert.equal(nextShopifyVendorPage({
  pageIndex: 0, maxPages: 100, hasNextPage: true, endCursor: "cursor-2", previousCursor: null,
}).action, "continue");
assert.deepEqual(nextShopifyVendorPage({
  pageIndex: 1, maxPages: 100, hasNextPage: true, endCursor: "same", previousCursor: "same",
}), { action: "incomplete", reason: "cursor_stuck" });

console.log("BASE identifier and Shopify page scan: 20 cases passed");
