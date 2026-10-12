import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const persistence = await readFile(new URL("../lib/market/persist-bestsellers.ts", import.meta.url), "utf8");
const cursorModule = await readFile(new URL("../lib/market/market-cursor.ts", import.meta.url), "utf8");
const marketRoute = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const cronLockMigration = await readFile(new URL("../supabase/migrations/20260929131500_cron_run_singleton_lock.sql", import.meta.url), "utf8");
const { nextMarketCursor } = await import("../lib/market/market-cursor-policy.mjs");

const guard = pipeline.indexOf("const emptyCollection = observation.itemCount === 0");
const finalReturn = pipeline.indexOf("return { ...observation, cursor, nextCursor: next };", guard);

assert.ok(!pipeline.includes("writeMarketCursor"), "patrol-ai must not write the shared cursor");
assert.ok(cursorModule.includes("nextMarketCursor"), "cursor transition must be centralized as a pure policy");
assert.ok(cronLockMigration.includes("cron_runs_one_running_job_uq"), "database unique index must enforce a single active market-sourcing worker");
assert.ok(marketRoute.includes("nextMarketCursor(observation)"), "market-sourcing must own cursor advancement");
const claim = marketRoute.indexOf('.insert({\n        job_name: "market-sourcing",\n        status: "running"');
const duplicateGuard = marketRoute.indexOf('cron_already_running');
const cursorRead = marketRoute.indexOf("readMarketCursor(supabase)");
assert.ok(claim >= 0 && duplicateGuard > claim && cursorRead > duplicateGuard, "the unique run claim and duplicate rejection must happen before cursor read/work");
assert.ok(guard >= 0, "evidence guard must remain in the pipeline");
assert.ok(finalReturn > guard, "normal success return must follow the retry guard");

const cursorPolicy = await readFile(new URL("../lib/market/market-cursor-policy.mjs", import.meta.url), "utf8");
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
// Executable cursor-policy regressions: same-source page resume and next-source rotation.
assert.deepEqual(
  nextMarketCursor({ sourceIndex: 2, nextIndex: 30, hasMore: true }),
  { sourceIndex: 2, startIndex: 30 },
  "mid-source progress must resume at the persisted next page instead of restarting at zero",
);
assert.deepEqual(
  nextMarketCursor({ sourceIndex: 2, nextIndex: 30, hasMore: false }),
  { sourceIndex: 3, startIndex: 0 },
  "an exhausted source must advance exactly once and reset its page offset",
);
assert.deepEqual(
  nextMarketCursor({ sourceIndex: 7, nextIndex: 200, hasMore: false }),
  { sourceIndex: 0, startIndex: 0 },
  "source rotation must wrap safely at the final source",
);
// The database claim is the concurrency boundary: a unique partial index permits
// one running row per job; the losing request returns 409 before reading cursor state.
const claim = marketRoute.indexOf('.insert({\\n        job_name: "market-sourcing",\\n        status: "running"');
const duplicateGuard = marketRoute.indexOf('cron_already_running');
const cursorRead = marketRoute.indexOf("readMarketCursor(supabase)");
assert.ok(claim >= 0 && duplicateGuard > claim && cursorRead > duplicateGuard, "concurrent loser must exit before cursor read or advancement");
assert.ok(cronLockMigration.includes("where status = 'running'"), "concurrency guard must be a partial unique index on active runs");
const patrolCursorWrites = (pipeline.match(/\\.from\\(["']cron_runs["']\\)\\.insert/g) ?? []).length;
assert.equal(patrolCursorWrites, 0, "patrol pipeline must not insert competing cursor checkpoints");
console.log("PASS: concurrent cursor ownership, mid-page resume, source rotation, child-page fallback, and evidence telemetry");
