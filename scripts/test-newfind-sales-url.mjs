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
assert.match(retryGate, /\.in\("status", \["pending", "failed", "sent", "sending"\]\)/,
  "NEWFIND retry scan must include expired sending leases so crashed attempts can be reclaimed");
assert.match(reconcile, /shopify_sync_status === "synced"/,
  "rescue must prioritize Shopify-synced products before unsynced rows");
assert.match(reconcile, /const columns = "id, title, base_item_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, shopify_sync_status, updated_at"/,
  "rescue gate checks must fetch the Japanese title they validate");
assert.match(reconcile, /\.select\("id, title, slug, bestseller_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons"\)/,
  "withdraw gate checks must fetch the Japanese title they validate");

assert.match(source, /const productUrl = tracerUrl/);
assert.match(source, /const tracerResolution = await resolveLiveTracerUrl/);
assert.match(source, /retryRejectedSchemaEvent/,
  "a fixed receiver schema must be allowed to replay a previously rejected integer-type event once");
assert.match(source, /:schema-retry/,
  "schema-fix replay must use a fresh event id so the receiver does not short-circuit a rejected inbox row");
assert.match(source, /Could not find the table .*tracer_promotions.*schema cache/,
  "a missing NEWFIND promotion ledger must be replayed with a fresh event ID after the migration is applied");
assert.match(source, /NEWFIND_TRACER_PROMOTION_LEDGER_READY/,
  "the retry loop must remain paused until the NEWFIND database migration is confirmed applied");
assert.match(source, /schemaBlocked: schemaBlockedIds\.size/,
  "retry telemetry must report promotions paused by the missing ledger");
assert.match(reconcile, /isNewfindPromotionLedgerSchemaBlocked/,
  "the rescue loop must not repeatedly retry schema-blocked promotions");
assert.match(reconcile, /schemaBlocked: number/,
  "rescue telemetry must expose the schema-blocked queue count");
assert.match(source, /resolveLiveTracerUrl\(typeof listing\.id === "string" \? listing\.id : null\)/,
  "NEWFIND must use a stable UUID product URL rather than an encoded Japanese slug");
assert.match(source, /tracer_sales_url_http_\$\{response\.status\}/, "record the actual HTTP status when a product page is not live");
assert.match(source, /tracer_sales_url_timeout/);
assert.match(source, /tracer_sales_url_not_live/);
assert.match(source, /return Math\.round\(Math\.max\(0, Math\.min\(100, Number\(match\[1\]\)\)\)\)/, "NEWFIND integer selection_score fields must never receive decimal values");
assert.match(source, /sales_url: productUrl/);
assert.match(source, /tracer_url: tracerUrl/);
assert.doesNotMatch(source, /shopify\.myshopify\.com|resolveLiveShopifyUrl/,
  "NEWFIND sales links must remain on the verified TRACER origin");

const productDetail = store.slice(store.indexOf("export async function getShopListingBySlug"), store.indexOf("export async function recordShopFunnelEvent"));
assert.match(productDetail, /const isListingId = \/\^\[0-9a-f\]/,
  "the product page route must resolve stable UUID URLs");
assert.doesNotMatch(productDetail, /loadLiveListings/,
  "the public product landing page must not disappear when the separate live-stock batch fails");
assert.match(productDetail, /listing\.supplierListingId/,
  "public landing pages must still have a supplier listing reference");
assert.doesNotMatch(productDetail, /getPublishableSupplierListingStatuses/,
  "supplier freshness checks belong to publication and order-time procurement, not the public landing page");
assert.match(productDetail, /\.eq\("shopify_sync_status", "synced"\)/,
  "only Shopify-synced products may have public sales pages");
assert.match(page, /href={shopifyProductUrl}/);
assert.match(page, /Shopifyで購入する/,
  "the TRACER landing page must direct customers to the live Shopify checkout");
console.log("NEWFIND retry gates and TRACER public sales links are guarded by regression tests.");
