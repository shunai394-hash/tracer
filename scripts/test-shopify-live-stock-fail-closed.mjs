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

const sync = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
assert.match(sync, /SUPPLIER_INVENTORY_MAX_AGE_MS = 30 \* 60 \* 1000/, "supplier inventory evidence must expire after 30 minutes");
assert.match(sync, /SUPPLIER_PRICE_MAX_AGE_MS = 30 \* 60 \* 1000/, "supplier price evidence must expire after 30 minutes");
assert.match(sync, /price_checked_at/, "supplier price observation timestamp must be loaded");
assert.match(sync, /supplier_price_checked_at, SUPPLIER_PRICE_MAX_AGE_MS/, "stale or missing supplier price evidence must block sync");
assert.match(sync, /SUPPLIER_SHIPPING_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000/, "supplier shipping evidence must expire after 24 hours");
assert.match(sync, /row\.supplier_verified_variant_id !== row\.supplier_variant_id/, "supplier variant identity must match exactly");
assert.match(sync, /supplier_cost_unconfirmed_or_mismatch/, "unconfirmed or mismatched supplier cost must block sync");
assert.match(sync, /supplier_shipping_unconfirmed_or_mismatch/, "unconfirmed or mismatched shipping must block sync");
assert.match(sync, /quantity: getShopifySellableInventory\(row\)/, "Shopify stock must use conservative sellable quantity, not full supplier stock");
assert.match(sync, /SHOPIFY_SELLABLE_STOCK_CAP = 3/, "Shopify sellable stock must have a low cap");
assert.match(sync, /verifiedSupplierStock - SHOPIFY_STOCK_SAFETY_BUFFER/, "Shopify sellable stock must preserve a supplier stock buffer");

const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(store, /shopify_live_stock_unconfigured/, "missing Shopify credentials must fail closed");
assert.match(store, /shopify_live_stock_variant_ids_empty/, "empty live-stock request must not use cached stock");
assert.match(store, /shopify_live_stock_response_incomplete/, "partial Shopify responses must be rejected");
assert.match(store, /shopify_live_stock_quantity_unknown/, "unknown quantities must be rejected");
assert.ok(store.includes('[shopify-live-stock-unavailable]') && store.includes("return [];"), "Shopify API failure must return no storefront listings");
assert.ok(store.includes("hasVerifiedPositiveShopifyStock(listing.shopifyVariantId, live)"), "storefront must use the tested stock policy");
assert.equal(store.includes("return live === undefined || live > 0"), false, "unknown live stock must never pass through");
assert.match(store, /const liveStock = await getLiveShopifyStock/, "order creation must recheck current Shopify stock");
assert.match(store, /shopify_live_stock_unverified/, "order creation must reject unverified stock");
assert.match(store, /requested quantity exceeds verified live inventory/, "quantity checks must use live-verified stock");

console.log("Shopify live-stock fail-closed checks: 26 passed (8 behavior cases + 18 source guards)");
