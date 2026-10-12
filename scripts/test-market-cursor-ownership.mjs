import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { advanceMarketCursor, normalizeMarketCursor } from "../lib/market/market-cursor-policy.ts";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const cursor = await readFile(new URL("../lib/market/market-cursor.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
const lockMigration = await readFile(new URL("../supabase/migrations/20260929131500_cron_run_singleton_lock.sql", import.meta.url), "utf8");

assert.deepEqual(advanceMarketCursor({ sourceIndex: 4, nextIndex: 30, hasMore: true }), { sourceIndex: 4, startIndex: 30 }, "resume the same source at the next page");
assert.deepEqual(advanceMarketCursor({ sourceIndex: 1, nextIndex: 10, hasMore: false }), { sourceIndex: 2, startIndex: 0 }, "move to the next source when a batch is exhausted");
assert.deepEqual(advanceMarketCursor({ sourceIndex: 7, nextIndex: 10, hasMore: false }), { sourceIndex: 0, startIndex: 0 }, "wrap after the final source");
assert.deepEqual(normalizeMarketCursor(9, 25), { sourceIndex: 1, startIndex: 25 }, "normalize source index without losing page offset");
assert.deepEqual(normalizeMarketCursor(-1, -1), { sourceIndex: 0, startIndex: 0 }, "invalid cursor values fail closed");

// Cursor persistence has one owner: market-sourcing. The intelligence patrol may
// calculate a preview, but cannot append a competing succeeded cursor row.
assert.ok(!pipeline.includes("writeMarketCursor"), "intelligence pipeline must not write the market cursor");
assert.ok(!cursor.includes(".insert({"), "cursor reader must not persist cursor rows");
assert.ok(route.includes('.insert({') && route.includes('job_name: "market-sourcing"'), "market-sourcing owns the run claim");
assert.ok(route.includes('cronClaimError.code === "23505"'), "concurrent market-sourcing claims must be rejected by the unique running-job constraint");
assert.ok(route.includes("metadataObject.sourceIndex") && route.includes("metadataObject.nextIndex"), "the owner resumes from the persisted source/page cursor");
assert.ok(lockMigration.includes("cron_runs_one_running_job_uq") && lockMigration.includes("where status = 'running'"), "database uniqueness must enforce a single running owner");
console.log("PASS: market cursor single-owner, concurrent-claim, next-source, and page-resume invariants");
