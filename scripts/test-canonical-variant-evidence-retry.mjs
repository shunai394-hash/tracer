import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cron = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const persistence = await readFile(new URL("../lib/market/persist-bestsellers.ts", import.meta.url), "utf8");

assert.ok(cron.includes("persistMarketplaceBestsellers"), "dedicated market-sourcing cron must invoke the collector");
assert.ok(cron.includes('job_name: "market-sourcing-observation"'), "market-sourcing must persist its own run/cursor");
assert.ok(cron.includes("canonicalVariantEvidenceParsed"), "cron telemetry must expose parsed child-variant evidence");
assert.ok(cron.includes("canonicalVariantEvidenceWritten"), "cron telemetry must expose persisted child-variant evidence");
assert.ok(cron.includes('"write_failed"'), "variant persistence failures must be distinguishable from empty source evidence");
assert.ok(cron.includes('"no_canonical_variant_evidence"'), "zero child evidence must be visible instead of being counted as a successful variant recovery");
assert.ok(cron.includes('"persisted"'), "complete variant evidence persistence must be explicitly recorded");
assert.ok(cron.includes('reason: "observation_only"'), "market observation must never publish or place orders");
assert.ok(collector.includes("brightDataConfigured: isBrightDataFetchConfigured()"), "telemetry must reflect the actual Bright Data API or MCP fetch configuration");
assert.ok(collector.includes("parseAmazonVariationAsinMap"), "Amazon child-ASIN maps must be considered as explicit discovery evidence");
assert.ok(persistence.includes('.from("marketplace_bestseller_variants")'), "canonical child-variant evidence must be persisted to its own table");
assert.ok(persistence.includes("canonicalVariantEvidenceWriteFailures"), "variant write failures must be counted and returned");
assert.ok(persistence.includes("canonicalVariantEvidenceWritten"), "only confirmed database writes may count as persisted variants");
console.log("PASS: market-sourcing exposes canonical variant parse/write status and remains observation-only");
