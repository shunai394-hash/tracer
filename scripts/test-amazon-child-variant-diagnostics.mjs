import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cron = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
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
assert.ok(cron.includes('reason: "observation_only"'), "marketplace collection must not publish ranking products or place orders");
assert.ok(vercel.crons.some((entry) => entry.path === "/api/cron/market-sourcing" && entry.schedule === "*/15 * * * *"),
  "market-sourcing must run on a schedule instead of remaining an unreachable route");

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
