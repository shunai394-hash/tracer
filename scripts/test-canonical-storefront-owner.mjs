import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyLegacyChannelItem, supplierIdentityKey } from "../lib/commerce/canonical-storefront-owner.ts";

assert.equal(supplierIdentityKey(" 123 ", " 456 "), "123\n456");
assert.equal(supplierIdentityKey("", "456"), null);
assert.equal(supplierIdentityKey("123", " "), null);

assert.equal(classifyLegacyChannelItem({
  legacyExternalId: "163355942",
  canonicalExternalId: "163355942",
}), "same_item");
assert.equal(classifyLegacyChannelItem({
  legacyExternalId: "gid://shopify/Product/99",
  canonicalExternalId: "99",
}), "same_item");
assert.equal(classifyLegacyChannelItem({
  legacyExternalId: "163159366",
  canonicalExternalId: "163355942",
}), "hide_duplicate");
assert.equal(classifyLegacyChannelItem({
  legacyExternalId: "163159366",
  canonicalExternalId: null,
}), "adopt");
assert.equal(classifyLegacyChannelItem({
  legacyExternalId: null,
  canonicalExternalId: "163355942",
}), "suppress_new_item");

const basePublisher = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const shopifySync = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
assert.match(basePublisher, /retireShopListingsOwnedByCommerce/);
assert.match(shopifySync, /retireShopListingsOwnedByCommerce/);
assert.match(basePublisher, /if \(retiredIds\.has\(listingId\)\) continue/);
assert.match(shopifySync, /retiredIds\.has\(String\(row\.id\)\)/);

console.log("canonical storefront owner: ok");
