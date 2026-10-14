import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasVerifiedPositiveShopifyStock } from "../lib/shop/live-stock-policy.ts";
import { toStorefrontStockQuantity } from "../lib/shopify/storefront-stock.ts";

const validVariant = "gid://shopify/ProductVariant/123";
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, 2), true, "positive verified live quantity is saleable");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, 0), false, "sold-out variant is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, -1), false, "negative quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, Number.NaN), false, "NaN quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, Number.POSITIVE_INFINITY), false, "infinite quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(validVariant, null), false, "unknown quantity is blocked");
assert.equal(hasVerifiedPositiveShopifyStock(null, 3), false, "missing variant ID is blocked");
assert.equal(hasVerifiedPositiveShopifyStock("SKU-123", 3), false, "non-Shopify variant ID is blocked");

assert.equal(toStorefrontStockQuantity(38786), 10, "supplier warehouse counts must never be copied wholesale into Shopify stock");
assert.equal(toStorefrontStockQuantity(8), 8, "small verified supplier counts remain conservative storefront stock");
assert.equal(toStorefrontStockQuantity(38786, 3), 3, "explicit storefront cap must be honored");
assert.equal(toStorefrontStockQuantity(38786, 500), 100, "configured storefront cap is itself bounded");
assert.equal(toStorefrontStockQuantity(0), 0, "zero supplier stock must remain zero");
assert.equal(toStorefrontStockQuantity("unknown"), 0, "unknown supplier stock must fail closed");

const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(store, /shopify_live_stock_unconfigured/, "missing Shopify credentials must fail closed");
assert.match(shopifySync, /toStorefrontStockQuantity\(row\.inventory, process\.env\.SHOPIFY_STOREFRONT_STOCK_CAP\)/, "supplier inventory must be projected through a bounded storefront cap before writing Shopify stock");
assert.match(shopifySync, /getLiveShopifyStock\(alreadySyncedVariantIds\)/, "already-synced Shopify products must be checked against actual live inventory before deciding they need no work");
assert.match(shopifySync, /liveQuantity !== toStorefrontStockQuantity\(row\.inventory, process\.env\.SHOPIFY_STOREFRONT_STOCK_CAP\)/, "inventory drift above or below the storefront cap must trigger bounded reconciliation");
assert.match(store, /shopify_live_stock_variant_ids_empty/, "empty live-stock request must not use cached stock");
assert.doesNotMatch(store, /shopify_live_stock_response_incomplete/, "one missing variant must not suppress every healthy storefront listing");
assert.match(store, /Missing\/retired variants fail closed per listing below/);
assert.match(store, /listing\.shopifySyncStatus === "synced" && Boolean\(listing\.shopifyVariantId\)/, "storefront must only load listings synced to Shopify");
assert.match(store, /shopify_live_stock_quantity_unknown/, "unknown quantities must be rejected");
assert.ok(store.includes('[shopify-live-stock-unavailable]') && store.includes("return [];"), "Shopify API failure must return no storefront listings");
assert.ok(store.includes("hasVerifiedPositiveShopifyStock(listing.shopifyVariantId, live)"), "storefront must use the tested stock policy");
assert.equal(store.includes("return live === undefined || live > 0"), false, "unknown live stock must never pass through");
assert.match(store, /const liveStock = await getLiveShopifyStock/, "order creation must recheck current Shopify stock");
assert.match(store, /shopify_live_stock_unverified/, "order creation must reject unverified stock");
assert.match(store, /requested quantity exceeds verified live inventory/, "quantity checks must use live-verified stock");

console.log("Shopify live-stock fail-closed checks: 26 passed (14 behavior cases + 12 source guards)");
