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
assert.match(vercel, /"path": "\/api\/cron\/market-sourcing"/,
  "the dedicated observation-only market cron remains scheduled for child-variant diagnostics");
assert.match(marketSourcingRoute, /reason: "observation_only"/,
  "marketplace observations must never become supplier identity or sales eligibility");
assert.doesNotMatch(marketSourcingRoute, /selectAndPublishSalesTests|promoteShopListingToNewfind/,
  "marketplace evidence must not publish products or place orders");
assert.match(bestsellerRoute, /marketplace_sourcing_disabled_supplier_native_only/,
  "the public bestsellers API must not act as a sourcing route");
assert.doesNotMatch(bestsellerRoute, /persistMarketplaceBestsellers|canonicalVariantEvidenceParsed/,
  "the public bestsellers API must not collect marketplace-derived variants");
console.log("PASS: supplier-native sourcing only; scheduled marketplace collection is observation-only");
