import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, reconcile] = await Promise.all([
  readFile(new URL("../lib/integration/newfind.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/integration/newfind-reconcile.ts", import.meta.url), "utf8"),
]);

const retryGate = source.slice(source.indexOf("export async function retryPendingNewfindPromotions"), source.indexOf("export async function promoteShopListingToNewfind"));
assert.match(retryGate, /\.select\("id, title, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons"\)/,
  "retry gate checks must fetch the Japanese title they validate");
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
console.log("NEWFIND uses only a liveness-checked TRACER-origin sales URL.");
