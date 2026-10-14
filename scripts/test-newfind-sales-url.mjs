import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/integration/newfind.ts", import.meta.url), "utf8");

assert.match(source, /const productUrl = tracerUrl/);
assert.match(source, /const tracerUrl = await resolveLiveTracerUrl/);
assert.match(source, /tracer_sales_url_not_live/);
assert.match(source, /sales_url: productUrl/);
assert.match(source, /tracer_url: tracerUrl/);
assert.doesNotMatch(source, /shopify\.myshopify\.com|resolveLiveShopifyUrl/,
  "NEWFIND sales links must remain on the verified TRACER origin");
console.log("NEWFIND uses only a liveness-checked TRACER-origin sales URL.");
