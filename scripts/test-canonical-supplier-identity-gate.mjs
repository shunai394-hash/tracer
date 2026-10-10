import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [helper, shopify, base, store, route, vercel] = await Promise.all([
  readFile(new URL("../lib/catalog/canonical-supplier-identity.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/unpublish-unlinked/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
]);
assert.match(helper, /identity_status === "linked"/);
assert.match(helper, /offset \+= 100/, "identity lookups must batch large supplier ID sets");
assert.match(shopify, /supplier_identity_unlinked/);
assert.match(shopify, /identity_status !== "linked"/);
assert.match(base, /identityUnlinkedIds/);
assert.match(base, /base_last_error: isIdentityUnlinked \? "supplier_identity_unlinked_hidden" : "tracer_unpublished_hidden"/);
assert.match(store, /supplierListingId && linkedSupplierIds\.has/);
assert.match(store, /supplier_identity_unlinked/);
assert.match(route, /published: false/);
assert.match(route, /publishPublishedListingsToBase\(50/);
assert.match(vercel, /"path": "\/api\/cron\/unpublish-unlinked"/);
console.log("Canonical supplier identity publication gates: 10 assertions passed");
