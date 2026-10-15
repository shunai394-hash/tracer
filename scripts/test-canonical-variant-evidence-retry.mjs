import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collectorRoute = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const bestsellerRoute = await readFile(new URL("../app/api/intelligence/bestsellers/route.ts", import.meta.url), "utf8");

assert.match(pipeline, /marketplace_sourcing_disabled_supplier_native_only/,
  "marketplace collection must be explicitly skipped in the patrol");
assert.doesNotMatch(pipeline, /writeMarketCursor|persistMarketplaceBestsellers/,
  "patrol must not read or advance marketplace sourcing cursors");
for (const [name, route] of [["market sourcing cron", collectorRoute], ["bestsellers API", bestsellerRoute]]) {
  assert.match(route, /marketplace_sourcing_disabled_supplier_native_only/, `${name} must be disabled`);
  assert.doesNotMatch(route, /persistMarketplaceBestsellers|canonicalVariantEvidenceParsed/,
    `${name} must not collect marketplace variant evidence`);
}
console.log("PASS: marketplace evidence retry path is disabled; supplier-native sourcing is authoritative");
