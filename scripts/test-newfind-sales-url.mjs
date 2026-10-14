import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/integration/newfind.ts", import.meta.url), "utf8");

assert.match(source, /async function resolveLiveShopifyUrl/);
assert.match(source, /listing\.shopify_sync_status !== "synced"/);
assert.match(source, /product\(id: \$id\) \{ id handle status \}/);
assert.match(source, /product\.status !== "ACTIVE"/);
assert.match(source, /const productUrl = shopifyUrl \?\? tracerUrl/);
assert.match(source, /no_live_shopify_or_tracer_sales_url/);
assert.match(source, /sales_url: productUrl/);
console.log("NEWFIND prefers a live, active Shopify sales URL and retains a checked TRACER fallback.");
