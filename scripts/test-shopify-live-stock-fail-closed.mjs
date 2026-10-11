import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasVerifiedPositiveShopifyStock } from "../lib/shop/live-stock-policy.ts";

const validVariant = "gid://shopify/ProductVariant/123";
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, 2), true, "positive verified live quantity is saleable");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, 0), false, "sold-out variant is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, -1), false, "negative quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, Number.NaN), false, "NaN quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, Number.POSITIVE_INFINITY), false, "infinite quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, null), false, "unknown quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(null, 3), false, "missing variant ID is blocked");
assert.equal(hasVerifiedPositiveShopifyStock("SKU-123", 3), false, "non-Shopify variant ID is blocked");

const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(store, /shopify_live_stock_unconfigured/, "missing Shopify credentials must fail closed");
assert.match(store, /shopify_live_stock_variant_ids_empty/, "empty live-stock request must not use cached stock");
assert.match(store, /shopify_live_stock_response_incomplete/, "partial Shopify responses must be rejected");
assert.match(store, /shopify_live_stock_quantity_unknown/, "unknown quantities must be rejected");
assert.match(store, /shopify-live-stock-unavailable[\\s\\S]{0,250}return \\[\\]/, "Shopify API failure must return no storefront listings");
assert.match(store, /hasVerifiedPositiveShopifyStock\\(listing\\.shopifyVariantId, live\\)/, "storefront must use the tested stock policy");
assert.doesNotMatch(store, /return live === undefined \\|\\| live > 0/, "unknown live stock must never pass through");
assert.match(store, /const liveStock = await getLiveShopifyStock/, "order creation must recheck current Shopify stock");
assert.match(store, /shopify_live_stock_unverified/, "order creation must reject unverified stock");
assert.match(store, /requested quantity exceeds verified live inventory/, "quantity checks must use live-verified stock");

console.log("Shopify live-stock fail-closed checks: 18 passed (8 behavior cases + 10 source guards)");
