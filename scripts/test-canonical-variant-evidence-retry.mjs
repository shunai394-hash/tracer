import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const cursorWrite = source.indexOf('const next = await writeMarketCursor(db, observation, "patrol-ai")');
const guard = source.indexOf("const emptyCollection = observation.itemCount === 0", cursorWrite);
const finalReturn = source.indexOf("return { ...observation, cursor, nextCursor: next };", guard);

assert.ok(cursorWrite >= 0, "market cursor must be persisted before collection/evidence retry decisions");
assert.ok(guard > cursorWrite, "empty-evidence guard must run after cursor advancement");
assert.ok(finalReturn > guard, "normal success return must follow the retry guard");
const guarded = source.slice(guard, finalReturn);
assert.ok(guarded.includes("observation.canonicalVariantEvidenceParsed === 0"), "zero canonical variant evidence must defer the stage");
assert.ok(guarded.includes("observation.canonicalVariantEvidenceWriteFailures > 0"), "evidence write failures must be detectable");
assert.ok(guarded.includes("skipped: true"), "unusable collection must not be treated as a completed stage");
// Observation-only sources (Yahoo/Rakuten, indices 0–1) must advance the cursor
// without blocking unrelated stages; an Amazon/evidence-capable source with empty
// evidence remains retryable. Never assert retryable=true for every skipped source.
assert.ok(guarded.includes("const sourceDoesNotProvideCanonicalChildVariants = observation.sourceIndex < 2"), "observation-only sources must be identified explicitly");
assert.ok(guarded.includes("retryable: !nonBlockingSourceCoverageSkip"), "only non-blocking observation-only skips may avoid retrying the stage");
assert.ok(guarded.includes('"source_has_no_canonical_child_variant_contract"'), "observation-only source reason must be explicit");
assert.ok(guarded.includes('"canonical_variant_evidence_empty"'), "zero-evidence reason must be explicit");
assert.ok(guarded.includes('"canonical_variant_evidence_write_failed"'), "persistence failure reason must be explicit");
console.log("PASS: canonical evidence deferral distinguishes observation-only sources from retryable Amazon evidence");
