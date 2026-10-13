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

const webhook = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
assert.match(webhook, /\.from\("supplier_listings"\)/, "Shopify order intake must re-read the canonical supplier row");
assert.match(webhook, /identity_status === "linked"/, "unlinked supplier identity must block order intake");
assert.match(webhook, /verification_status === "verified"/, "unverified supplier rows must block order intake");
assert.match(webhook, /api_available === true/, "supplier API readiness must be confirmed at order intake");
assert.match(webhook, /tracking_available === true/, "supplier tracking readiness must be confirmed at order intake");
assert.match(webhook, /price_confirmed === true/, "supplier price must be confirmed at order intake");
assert.match(webhook, /inventory_confirmed === true/, "supplier inventory must be confirmed at order intake");
assert.match(webhook, /Number.isFinite\(inventory\) && inventory! > 0/, "supplier inventory must be confirmed and positive");
assert.match(webhook, /requestedBySupplierListing/, "duplicate line quantities must be aggregated by canonical supplier listing");
assert.match(webhook, /supplier_inventory_insufficient/, "combined requested quantity must block confirmed-stock oversell");
assert.match(webhook, /Number.isFinite\(sourceCost\) && sourceCost! > 0/, "missing or non-positive supplier cost must block order intake");
assert.match(webhook, /Number.isFinite\(shippingCost\) && shippingCost! >= 0/, "unknown or invalid supplier shipping cost must block order intake");
assert.match(webhook, /supplier_fulfillment_gate_failed/, "failed supplier gate must return a block reason");
assert.ok(webhook.indexOf("supplier_fulfillment_gate_failed") < webhook.indexOf('.from("shop_orders").insert'), "supplier gate must run before parent order creation");
assert.match(webhook, /createDropshipPurchaseOrdersForShopOrder/, "paid Shopify webhook orders must initialize idempotent procurement snapshots");
assert.match(webhook, /payment_status: "paid"/, "a later Shopify paid event must promote an existing pending order");
assert.match(webhook, /if \(paid \|\| paymentStatus === "paid"\)/, "duplicate paid deliveries must retry procurement initialization");
assert.match(webhook, /shop_order_items_insert_failed/, "line-item persistence failures must be surfaced");
assert.ok(webhook.includes('.from("shop_order_items").insert(itemRows)'), "all line items must be inserted as one batch");
assert.ok(webhook.indexOf("shop_order_items_insert_failed") > webhook.indexOf('.from("shop_orders").insert'), "item failure handling must run after parent insertion");
assert.match(webhook, /\.from\("shop_orders"\)\.delete\(\)\.eq\("id", inserted\.data\.id\)/, "failed line-item writes must clean up the parent order so webhook retry can recover");


const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(store, /shopify_live_stock_unconfigured/, "missing Shopify credentials must fail closed");
assert.match(store, /shopify_live_stock_variant_ids_empty/, "empty live-stock request must not use cached stock");
assert.match(store, /shopify_live_stock_response_incomplete/, "partial Shopify responses must be rejected");
assert.match(store, /shopify_live_stock_quantity_unknown/, "unknown quantities must be rejected");
assert.ok(store.includes('[shopify-live-stock-unavailable]') && store.includes("return [];"), "Shopify API failure must return no storefront listings");
assert.ok(store.includes("hasVerifiedPositiveShopifyStock(listing.shopifyVariantId, live)"), "storefront must use the tested stock policy");
assert.equal(store.includes("return live === undefined || live > 0"), false, "unknown live stock must never pass through");
assert.match(store, /const liveStock = [^;]*await getLiveShopifyStock/, "order creation must recheck current Shopify stock");
assert.match(store, /shopify_live_stock_unverified/, "order creation must reject unverified stock");
assert.match(store, /requested quantity exceeds verified live inventory/, "quantity checks must use live-verified stock");

console.log("Shopify live-stock fail-closed checks: 18 passed (8 behavior cases + 10 source guards)");
