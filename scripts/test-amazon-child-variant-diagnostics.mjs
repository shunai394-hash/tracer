import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cron = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const brightdataIngest = await readFile(new URL("../app/api/intelligence/brightdata-ingest/route.ts", import.meta.url), "utf8");
const bestsellerApi = await readFile(new URL("../app/api/intelligence/bestsellers/route.ts", import.meta.url), "utf8");
const sourceDecision = await readFile(new URL("../app/api/intelligence/source-decision/route.ts", import.meta.url), "utf8");
const marketObserve = await readFile(new URL("../app/api/intelligence/market-observe/route.ts", import.meta.url), "utf8");
const supplierInvestigation = await readFile(new URL("../app/api/cron/supplier-investigation/route.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

for (const [name, source] of [
  ["market-sourcing cron", cron],
  ["Bright Data ingest API", brightdataIngest],
  ["bestsellers API", bestsellerApi],
  ["source-decision API", sourceDecision],
  ["market-observe API", marketObserve],
  ["supplier-investigation cron", supplierInvestigation],
]) {
  assert.ok(source.includes("marketplace_sourcing_disabled_supplier_native_only"), `${name} must be disabled`);
  assert.doesNotMatch(source, /persistMarketplaceBestsellers|investigateDropshipForBestsellers|matchDemandProductsByCategory/,
    `${name} must not read marketplace-derived sourcing data`);
}
assert.ok(pipeline.includes("marketplace_sourcing_disabled_supplier_native_only"), "patrol must skip marketplace collection");
assert.doesNotMatch(pipeline, /persistMarketplaceBestsellers|selectAndPublishSalesTests|promoteShopListingToNewfind/,
  "TRACER patrol must not source from marketplaces or publish to out-of-scope NEWFIND");
console.log("Marketplace sourcing disabled; supplier-native-only workflow assertions passed");
