import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const persistence = await readFile(new URL("../lib/market/persist-bestsellers.ts", import.meta.url), "utf8");

const cursorWrite = pipeline.indexOf("const next = await writeMarketCursor(db, {");
const guard = pipeline.indexOf("const emptyCollection = observation.itemCount === 0", cursorWrite);
const finalReturn = pipeline.indexOf("return { ...observation, cursor, nextCursor: next };", guard);

assert.ok(cursorWrite >= 0, "market cursor must be persisted before collection/evidence retry decisions");
assert.ok(guard > cursorWrite, "empty-evidence guard must run after cursor advancement");
assert.ok(finalReturn > guard, "normal success return must follow the retry guard");
const cursorBlock = pipeline.slice(cursorWrite, guard);
assert.ok(cursorBlock.includes("hasMore: observation.hasMore && observation.sourceIndex >= 2"), "Yahoo/Rakuten must rotate after one bounded batch while Amazon evidence sources may continue paging");

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
console.log("PASS: cursor rotation, child-page fallback, and aggregate evidence telemetry are wired");
