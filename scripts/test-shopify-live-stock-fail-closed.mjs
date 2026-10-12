import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasVerifiedPositiveShopifyStock } from "../lib/shop/live-stock-policy.ts";
import { timestampIsFresh } from "../lib/shopify/supplier-evidence-freshness.ts";

const validVariant = "gid://shopify/ProductVariant/123";
const now = Date.parse("2026-10-12T00:00:00.000Z");
const thirtyMinutes = 30 * 60 * 1000;
assert.equal(timestampIsFresh(new Date(now - thirtyMinutes).toISOString(), thirtyMinutes, now), true, "timestamp exactly at freshness boundary is accepted");
assert.equal(timestampIsFresh(new Date(now - thirtyMinutes - 1).toISOString(), thirtyMinutes, now), false, "timestamp one millisecond past boundary is stale");
assert.equal(timestampIsFresh(new Date(now + 1).toISOString(), thirtyMinutes, now), false, "future timestamp is rejected");
assert.equal(timestampIsFresh("not-a-timestamp", thirtyMinutes, now), false, "malformed timestamp is rejected");
assert.equal(timestampIsFresh(null, thirtyMinutes, now), false, "null timestamp is rejected");
assert.equal(timestampIsFresh(undefined, thirtyMinutes, now), false, "missing timestamp is rejected");
assert.equal(timestampIsFresh("", thirtyMinutes, now), false, "empty timestamp is rejected");
assert.equal(timestampIsFresh(new Date(now).toISOString(), -1, now), false, "negative freshness window is rejected");

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
assert.match(sync, /supplier_cost_unconfirmed_stale_or_mismatch/, "unconfirmed or mismatched supplier cost must block sync");
assert.match(sync, /select\("id,supplier_variant_id,cost,currency,shipping_cost/, "supplier evidence currency must be loaded with the observed cost");
assert.match(sync, /String\(row\.supplier_currency \?\? ""\)\.trim\(\)\.toUpperCase\(\) !== "JPY"/, "non-JPY supplier costs must block Shopify sync even when numeric amounts happen to match");
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

console.log("Shopify live-stock fail-closed checks: 34 passed (16 behavior cases + 18 source guards)");

const refresh = await readFile(new URL("../app/api/cron/inventory-refresh/route.ts", import.meta.url), "utf8");
assert.match(refresh, /priceResult\.currency\?\.trim\(\)\.toUpperCase\(\) === "JPY"/, "supplier price must be JPY before it is stored in JPY fields");
assert.match(refresh, /shippingResult\.currency\?\.trim\(\)\.toUpperCase\(\) === "JPY"/, "Japan shipping amount must be JPY before it is stored in JPY fields");
assert.match(refresh, /fresh_supplier_variant_price_or_japan_shipping_unverified/, "non-JPY or unverified supplier evidence must fail closed");

console.log("Supplier price/shipping currency guards: 3 passed");

assert.match(refresh, /supplier_cost_changed_profitability_retest_required/, "changed supplier economics must invalidate prior profitability approval");
assert.match(refresh, /contribution_profit: null/, "changed supplier costs must clear stale contribution profit");
assert.match(refresh, /contribution_margin: null/, "changed supplier costs must clear stale contribution margin");
assert.match(refresh, /selection_reasons: invalidatedReasons/, "changed supplier costs must persist invalidated sales-test provenance");
assert.match(refresh, /reason !== SALES_TEST_GATE_PASSED/, "changed supplier costs must remove the prior Sales Test Gate pass marker");
assert.match(refresh, /pipeline_stage: "BLOCKED"/, "changed supplier economics must block the listing pending retest");
assert.match(refresh, /visible: false/, "changed supplier economics must hide the linked BASE item");

assert.match(refresh, /pipeline_reason: reason/, "unverified supplier evidence must set a blocking pipeline reason");
assert.match(refresh, /contribution_profit: null/, "unverified supplier evidence must clear stale contribution profit");
assert.match(refresh, /selection_reasons\.map\(\(item: unknown\) => String\(item\)\)\.filter\(\(item: string\) => item !== SALES_TEST_GATE_PASSED\)/, "unverified supplier evidence must revoke prior sales-test approval");
