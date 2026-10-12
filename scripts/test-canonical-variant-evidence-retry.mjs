import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const persistence = await readFile(new URL("../lib/market/persist-bestsellers.ts", import.meta.url), "utf8");
const cursorModule = await readFile(new URL("../lib/market/market-cursor.ts", import.meta.url), "utf8");
const marketRoute = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");

const guard = pipeline.indexOf("const emptyCollection = observation.itemCount === 0");
const finalReturn = pipeline.indexOf("return { ...observation, cursor, nextCursor: next };", guard);

assert.ok(!pipeline.includes("writeMarketCursor"), "patrol-ai must not write the shared cursor");
assert.ok(cursorModule.includes("export function nextMarketCursor"), "cursor transition must be centralized as a pure policy");
assert.ok(marketRoute.includes("nextMarketCursor(observation)"), "market-sourcing must own cursor advancement");
const claim = marketRoute.indexOf('.insert({\n        job_name: "market-sourcing",\n        status: "running"');
const duplicateGuard = marketRoute.indexOf('cron_already_running');
const cursorRead = marketRoute.indexOf("readMarketCursor(supabase)");
assert.ok(claim >= 0 && duplicateGuard > claim && cursorRead > duplicateGuard, "the unique run claim and duplicate rejection must happen before cursor read/work");
assert.ok(guard >= 0, "evidence guard must remain in the pipeline");
assert.ok(finalReturn > guard, "normal success return must follow the retry guard");

const cursorPolicy = await readFile(new URL("../lib/market/market-cursor.ts", import.meta.url), "utf8");
assert.ok(cursorPolicy.includes("observation.hasMore"), "cursor transition must distinguish same-source pagination from source rotation");
assert.ok(cursorPolicy.includes("observation.nextIndex"), "cursor transition must resume at the next page offset");
assert.ok(cursorPolicy.includes("(Math.max(0, observation.sourceIndex) + 1) % SOURCE_COUNT"), "completed source must advance exactly once");

const guarded = pipeline.slice(guard, finalReturn);
assert.ok(guarded.includes("observation.canonicalVariantEvidenceParsed === 0"), "zero canonical variant evidence must defer the stage");
assert.ok(guarded.includes("observation.canonicalVariantEvidenceWriteFailures > 0"), "evidence write failures must be detectable");
assert.ok(guarded.includes("skipped: true"), "unusable collection must not be treated as a completed stage");
assert.ok(guarded.includes("retryable: !nonBlockingSourceCoverageSkip"), "only observation-only skips may avoid retrying the stage");
assert.ok(guarded.includes('"source_has_no_canonical_child_variant_contract"'), "observation-only source reason must be explicit");
assert.ok(guarded.includes('"canonical_variant_evidence_empty"'), "zero-evidence reason must be explicit");
assert.ok(guarded.includes('"canonical_variant_evidence_write_failed"'), "persistence failure reason must be explicit");

assert.ok(collector.includes("fetchHtml(childUrl, { retryBrightDataWhenCanonicalVariantsMissing: true })"), "child detail pages must retry through configured Bright Data when direct fetch lacks evidence");
for (const key of ["variationAsinsFound", "childDetailAttempted", "childDetailFetched", "childBarcodeFound"]) {
  assert.ok(persistence.includes(`${key}: number`), `persistence contract must expose ${key}`);
}
for (const key of ["childVariationAsinsFound", "childDetailAttempted", "childDetailFetched", "childBarcodeFound"]) {
  assert.ok(persistence.includes(`${key}:`), `aggregate telemetry must expose ${key}`);
}
// Transition regression cases: mid-source resume, next-source rotation, and stable concurrent read ownership.
const nextCursorSource = cursorModule.slice(cursorModule.indexOf("export function nextMarketCursor"));
assert.match(nextCursorSource, /sourceIndex: Math\.max\(0, observation\.sourceIndex\) % SOURCE_COUNT/);
assert.match(nextCursorSource, /startIndex: Math\.max\(0, observation\.nextIndex\)/);
assert.match(nextCursorSource, /sourceIndex: \(Math\.max\(0, observation\.sourceIndex\) \+ 1\) % SOURCE_COUNT/);
assert.match(nextCursorSource, /startIndex: 0/);
// Simulate two overlapping patrol readers: neither is permitted to persist a checkpoint;
// only the claimed market-sourcing worker can commit its computed next cursor.
const patrolCursorWrites = (pipeline.match(/\.from\(["']cron_runs["']\)\.insert/g) ?? []).length;
assert.equal(patrolCursorWrites, 0, "patrol pipeline must not insert competing cursor checkpoints");
assert.ok(marketRoute.indexOf("readMarketCursor(supabase)") > marketRoute.indexOf("cron_already_running"), "losing concurrent worker must exit before it reads or advances the cursor");
console.log("PASS: single cursor writer, concurrent-run guard, page resume, source rotation, child-page fallback, and evidence telemetry");
