import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasVerifiedPositiveShopifyStock } from "../lib/shop/live-stock-policy.ts";
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

assert.match(store, /shopify_live_stock_not_configured/, "missing Shopify credentials must fail closed");
assert.match(store, /shopify_live_stock_no_variant_ids/, "an empty live-stock request must not silently use stale database stock");
assert.match(store, /shopify_live_stock_incomplete_response/, "partial Shopify responses must be rejected");
assert.match(store, /shopify_live_stock_quantity_unknown/, "unknown inventory quantities must be rejected");
assert.match(store, /Math\.max\(0, Math\.floor\(quantity\)\)/, "negative inventory must mark only that variant sold out");
assert.match(store, /shopify-live-stock-unavailable[\s\S]{0,250}return \[\]/, "Shopify API failure must return no storefront listings");
assert.match(store, /hasVerifiedPositiveShopifyStock/, "storefront must use the tested fail-closed live stock policy");
assert.doesNotMatch(store, /return live === undefined \|\| live > 0/, "unknown live stock must never pass through to the storefront");

assert.match(store, /const verifiedListings = await loadLiveListings/, "order creation must revalidate current stock through the fail-closed loader");
assert.match(store, /listing inventory could not be verified against current channel state/, "order creation must reject when current stock cannot be verified");
assert.match(store, /const inventory = verifiedListing\.inventory/, "quantity checks must use live-verified inventory, not only cached DB quantity");

console.log("Shopify live-stock fail-closed guards: 19 passed (8 behavior cases + 11 source guards)");
