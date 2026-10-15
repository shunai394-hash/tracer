import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [pipeline, marketSourcingRoute, bestsellerRoute, vercel] = await Promise.all([
  readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/intelligence/bestsellers/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
]);

assert.match(pipeline, /marketplace_sourcing_disabled_supplier_native_only/,
  "the production patrol must explicitly use supplier-native sourcing");
assert.doesNotMatch(pipeline, /writeMarketCursor|persistMarketplaceBestsellers/,
  "the production patrol must not read or advance marketplace sourcing cursors");
assert.doesNotMatch(pipeline, /selectAndPublishSalesTests|promoteShopListingToNewfind/,
  "the production patrol must not treat marketplace observations as supplier products or publish out-of-scope feeds");
for (const [name, route] of [["market sourcing cron", marketSourcingRoute], ["bestsellers API", bestsellerRoute]]) {
  assert.match(route, /marketplace_sourcing_disabled_supplier_native_only/, `${name} must be disabled`);
  assert.doesNotMatch(route, /persistMarketplaceBestsellers|canonicalVariantEvidenceParsed/,
    `${name} must not collect marketplace-derived variant evidence`);
}
assert.doesNotMatch(vercel, /"path": "\/api\/cron\/market-sourcing"/,
  "marketplace ranking collection must not run on a production schedule");
console.log("PASS: supplier-native sourcing only; marketplace evidence is demand-only and not a sales dependency");
