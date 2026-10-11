import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url),
  "utf8",
);
const cursorWrite = source.indexOf('const next = await writeMarketCursor(db, observation, "patrol-ai")');
const emptyGuard = source.indexOf("const emptyCollection = observation.itemCount === 0", cursorWrite);
const reason = source.indexOf('reason: emptyCollection', emptyGuard);
const normalReturn = source.indexOf("return { ...observation, cursor, nextCursor: next };", emptyGuard);

assert.ok(cursorWrite >= 0, "market cursor write must exist");
assert.ok(emptyGuard > cursorWrite, "empty-evidence gate must run after cursor persistence");
assert.ok(reason > emptyGuard, "zero evidence must have a reason");
assert.ok(normalReturn > reason, "normal completion must only occur after evidence gate");
const guard = source.slice(emptyGuard, normalReturn);
for (const fragment of [
  "observation.itemCount === 0",
  "observation.canonicalVariantEvidenceParsed === 0",
  "observation.canonicalVariantEvidenceWritten === 0",
  "observation.canonicalVariantEvidenceWriteFailures > 0",
  "skipped: true",
  "retryable: true",
  "marketplace_collection_empty",
  "canonical_variant_evidence_empty",
  "canonical_variant_evidence_write_failed",
]) {
  assert.ok(guard.includes(fragment), `marketplace stage must guard: ${fragment}`);
}
const bestsellerIdGuard = source.slice(
  source.indexOf("const bestsellerIds ="),
  source.indexOf("const supplierCandidateIds ="),
);
const supplierIdGuard = source.slice(
  source.indexOf("const supplierCandidateIds ="),
  source.indexOf('steps.push(await runStep("auxiliary_trends"'),
);
assert.match(bestsellerIdGuard, /bestsellerStep\.ok && !bestsellerStep\.skipped/);
assert.match(supplierIdGuard, /bestsellerStep\.ok && !bestsellerStep\.skipped/);
console.log("PASS: empty collection/evidence/write failure defers patrol and blocks downstream sales candidates");
