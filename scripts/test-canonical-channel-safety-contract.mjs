import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [shopify, basePublisher, shopifyRoute, baseRoute, vercel] = await Promise.all([
  readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/shopify-publish/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/base-publish/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
]);

// These are regression contracts for the real cron-to-service call paths.
// External writes remain disabled in this test: it only inspects source.
assert.match(shopifyRoute, /syncPublishedListingsToShopify\(150\)/);
assert.match(baseRoute, /publishPublishedListingsToBase\(50\)/);
assert.match(shopify, /supplier_variant_missing/);
assert.match(shopify, /supplier_product_missing/);
assert.match(shopify, /canonical_product_id_missing/);
assert.match(shopify, /currency_not_jpy/);
assert.match(shopify, /inventory_zero_or_unknown/);
assert.match(shopify, /profit_not_positive/);
assert.match(shopify, /margin_not_positive/);
assert.match(basePublisher, /supplier_variant_identity_missing/);
assert.match(basePublisher, /source_cost_unknown_or_invalid/);
assert.match(basePublisher, /profit_not_positive_or_unknown/);
assert.match(basePublisher, /margin_not_positive_or_unknown/);
assert.match(basePublisher, /base_economics_block_hide_failed/);

// The established patrol loop is preserved; the safety patch must not silently
// remove scheduled monitoring while tightening publication gates.
assert.match(vercel, /"path": "\/api\/cron\/patrol-ai"/);
console.log("Canonical channel safety contracts passed.");
