import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, reconcile, store, page] = await Promise.all([
  readFile(new URL("../lib/integration/newfind.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/integration/newfind-reconcile.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/shop/[slug]/page.tsx", import.meta.url), "utf8"),
]);

const retryGate = source.slice(source.indexOf("export async function retryPendingNewfindPromotions"), source.indexOf("export async function promoteShopListingToNewfind"));
assert.match(retryGate, /\.select\("id, title, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, shopify_sync_status"\)/,
  "retry gate checks must fetch the Japanese title and channel state they validate");
assert.match(retryGate, /shopifyStatusById\.get\(b\) === "synced"/,
  "NEWFIND retries must prioritize products already live on Shopify");
assert.match(reconcile, /shopify_sync_status === "synced"/,
  "rescue must prioritize Shopify-synced products before unsynced rows");
assert.match(reconcile, /const columns = "id, title, base_item_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, updated_at"/,
  "rescue gate checks must fetch the Japanese title they validate");
assert.match(reconcile, /\.select\("id, title, slug, bestseller_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons"\)/,
  "withdraw gate checks must fetch the Japanese title they validate");

assert.match(source, /const productUrl = tracerUrl/);
assert.match(source, /const tracerUrl = await resolveLiveTracerUrl/);
assert.match(source, /tracer_sales_url_not_live/);
assert.match(source, /sales_url: productUrl/);
assert.match(source, /tracer_url: tracerUrl/);
assert.doesNotMatch(source, /shopify\.myshopify\.com|resolveLiveShopifyUrl/,
  "NEWFIND sales links must remain on the verified TRACER origin");

const productDetail = store.slice(store.indexOf("export async function getShopListingBySlug"), store.indexOf("export async function recordShopFunnelEvent"));
assert.doesNotMatch(productDetail, /loadLiveListings/,
  "the public product landing page must not disappear when the separate live-stock batch fails");
assert.match(productDetail, /getPublishableSupplierListingStatuses/,
  "supplier identity and freshness must still be verified");
assert.match(productDetail, /\.eq\("shopify_sync_status", "synced"\)/,
  "only Shopify-synced products may have public sales pages");
assert.match(page, /href={shopifyProductUrl}/);
assert.match(page, /Shopifyで購入する/,
  "the TRACER landing page must direct customers to the live Shopify checkout");
console.log("NEWFIND retry gates and TRACER public sales links are guarded by regression tests.");
