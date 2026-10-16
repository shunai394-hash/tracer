import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cron = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const variantParser = await readFile(new URL("../lib/market/canonical-variant-evidence.ts", import.meta.url), "utf8");
const bestsellerApi = await readFile(new URL("../app/api/intelligence/bestsellers/route.ts", import.meta.url), "utf8");
const sourceDecision = await readFile(new URL("../app/api/intelligence/source-decision/route.ts", import.meta.url), "utf8");
const marketObserve = await readFile(new URL("../app/api/intelligence/market-observe/route.ts", import.meta.url), "utf8");
const supplierInvestigation = await readFile(new URL("../app/api/cron/supplier-investigation/route.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

assert.ok(cron.includes("persistMarketplaceBestsellers"), "dedicated observation cron must invoke the marketplace collector");
assert.ok(cron.includes('job_name: "market-sourcing-observation"'), "observation cursor must be isolated from patrol skip records");
assert.ok(!cron.includes('job_name: "market-sourcing"'), "patrol telemetry must not reset the market-source cursor");
assert.ok(cron.includes("canonicalVariantEvidenceParsed"), "cron must report parsed child-variant evidence");
assert.ok(cron.includes("export const maxDuration = 300;"), "marketplace detail scraping needs a 300-second runtime budget");
assert.ok(cron.includes("canonicalVariantEvidenceWritten"), "cron must report persisted child-variant evidence");
assert.match(cron, /MARKETPLACE_SOURCES\.length/, "source rotation must adapt when demand categories are added");
assert.match(variantParser, /dimensionToAsinMap/, "Amazon child-ASIN variation maps must be parsed");
assert.match(variantParser, /dimensionToAsinMapMarkerCount/, "aggregate diagnostics must show whether Amazon variation maps exist in fetched HTML");
assert.match(collector, /dimensionToAsinMapMarkerCount: number/, "cron telemetry must persist variation-map diagnostics");
assert.match(collector, /jsonLdScriptTagCount \+= markup\.jsonLdScriptTagCount/, "cron telemetry must record JSON-LD script counts");
assert.match(collector, /variationMapMarkerCount \+= markup\.variationMapMarkerCount/, "cron telemetry must record variation-map marker counts");
assert.match(collector, /child_detail_has_barcode: hasBarcode/, "child-page barcode state must be recorded as evidence");
assert.doesNotMatch(collector, /if \(!jan && !gtin && !ean && !upc\) return null/,
  "ASIN-only child evidence must still be persisted; barcode is a separate supplier-linking gate");
assert.ok(cron.includes('reason: "observation_only"'), "marketplace collection must not publish ranking products or place orders");
const activeSourceStart = collector.indexOf("export const MARKETPLACE_SOURCES");
const activeSourceEnd = collector.indexOf("];", activeSourceStart);
const activeSourceBlock = collector.slice(activeSourceStart, activeSourceEnd);
assert.match(activeSourceBlock, /yahoo_shopping_ranking/, "Yahoo! Shopping remains demand research only");
assert.doesNotMatch(activeSourceBlock, /amazon_bestsellers|rakuten_ranking/, "Amazon and Rakuten must not be active demand fetch sources");

assert.deepEqual(vercel.crons.filter((entry) => entry.path === "/api/cron/market-sourcing"), [],
  "market-sourcing must not run on a schedule in the supplier-native rebuild");

for (const [name, source] of [
  ["bestsellers API", bestsellerApi],
  ["source-decision API", sourceDecision],
  ["market-observe API", marketObserve],
  ["supplier-investigation cron", supplierInvestigation],
]) {
  assert.ok(source.includes("marketplace_sourcing_disabled_supplier_native_only"), `${name} must remain supplier-native-only`);
  assert.doesNotMatch(source, /persistMarketplaceBestsellers|investigateDropshipForBestsellers|matchDemandProductsByCategory/,
    `${name} must not read marketplace-derived sourcing data`);
}
assert.ok(pipeline.includes("marketplace_sourcing_disabled_supplier_native_only"), "patrol must leave market observation to its dedicated cron");
assert.doesNotMatch(pipeline, /persistMarketplaceBestsellers|selectAndPublishSalesTests|promoteShopListingToNewfind/,
  "TRACER patrol must not publish marketplace-derived products or promote to out-of-scope NEWFIND");
console.log("Dedicated market observation cron and supplier-native publication boundaries passed");
