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
assert.ok(guarded.includes("observation.canonicalVariantEvidenceParsed === 0"), "zero canonical variant evidence must defer the stage");
assert.ok(guarded.includes("observation.canonicalVariantEvidenceWriteFailures > 0"), "evidence write failures must be detectable");
assert.ok(guarded.includes("skipped: true"), "unusable collection must not be treated as a completed stage");
assert.ok(guarded.includes("retryable: true"), "zero evidence must always be retryable for the enabled Yahoo source");
assert.ok(guarded.includes('"canonical_variant_evidence_empty"'), "zero-evidence reason must be explicit");
assert.ok(guarded.includes('"canonical_variant_evidence_write_failed"'), "persistence failure reason must be explicit");
assert.ok(!guarded.includes("sourceDoesNotProvideCanonicalChildVariants"), "cursor index must not suppress retries for Yahoo child-variant evidence");
assert.ok(!guarded.includes("source_has_no_canonical_child_variant_contract"), "removed marketplaces must not be treated as a successful observation-only source");
assert.ok(collector.includes('reason: "marketplace_source_removed_by_policy"'), "Amazon/Rakuten must remain explicitly excluded");
assert.ok(collector.includes("parseYahooRankingHtml(html)"), "the enabled Yahoo source must be parsed");
console.log("PASS: Yahoo-only sourcing and canonical child-variant evidence gate stay aligned");
