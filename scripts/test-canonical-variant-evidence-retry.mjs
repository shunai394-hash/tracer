import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const cursorWrite = source.indexOf('const next = await writeMarketCursor(db, observation, "patrol-ai")');
const guard = source.indexOf("const emptyCollection = observation.itemCount === 0", cursorWrite);
const finalReturn = source.indexOf("return { ...observation, cursor, nextCursor: next };", guard);

assert.ok(cursorWrite >= 0, "market cursor must be persisted before collection/evidence retry decisions");
assert.ok(guard > cursorWrite, "empty-evidence guard must run after cursor advancement");
assert.ok(finalReturn > guard, "normal success return must follow the retry guard");
const guarded = source.slice(guard, finalReturn);
assert.ok(guarded.includes("observation.canonicalVariantEvidenceParsed === 0"), "zero canonical variant evidence must defer the stage when a source is active");
assert.ok(guarded.includes("observation.canonicalVariantEvidenceWriteFailures > 0"), "evidence write failures must be detectable");
assert.ok(guarded.includes("skipped: true"), "unusable collection must not be treated as a completed stage");
assert.ok(guarded.includes("retryable: true"), "missing or unpersisted evidence from an active source must remain retryable");
assert.ok(guarded.includes('"canonical_variant_evidence_empty"'), "zero-evidence reason must be explicit");
assert.ok(guarded.includes('"canonical_variant_evidence_write_failed"'), "persistence failure reason must be explicit");
assert.ok(guarded.includes('"marketplace_collection_disabled"'), "disabled marketplace collection must have an explicit skip reason");
assert.ok(guarded.includes("retryable: false"), "disabled marketplace collection must not be retried");
assert.match(collector, /MARKETPLACE_SOURCES:\s*Array<\{[^}]+\}>\s*=\s*\[\]/, "marketplace ranking intake must remain disabled");
console.log("PASS: disabled marketplace intake skips without retry; active-source evidence failures remain retryable");
