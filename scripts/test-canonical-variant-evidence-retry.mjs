import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

assert.match(pipeline, /marketplace_sourcing_disabled_supplier_native_only/,
  "the production patrol must explicitly use supplier-native sourcing");
assert.doesNotMatch(pipeline, /writeMarketCursor|persistMarketplaceBestsellers/,
  "the production patrol must not read or advance marketplace sourcing cursors");
assert.doesNotMatch(pipeline, /selectAndPublishSalesTests|promoteShopListingToNewfind/,
  "the production patrol must not treat marketplace observations as supplier products or publish out-of-scope feeds");
console.log("PASS: production patrol is supplier-native only; marketplace evidence is not a sourcing dependency");
