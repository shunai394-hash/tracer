import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = await mkdtemp(join(tmpdir(), "base-reconciliation-"));
try {
  const input = join(dir, "report.json");
  const report = {
    complete: true,
    generatedAt: "2026-10-12T00:00:00.000Z",
    baseItemCount: 4,
    baseVisibleCount: 3,
    baseHiddenCount: 1,
    tracerListingCount: 3,
    exactBaseIdMappedCount: 1,
    baseItemsWithoutExactMappingCount: 3,
    tracerListingsWithoutBaseItemIdCount: 2,
    duplicateBaseItemIdGroupsInTracer: 0,
    items: [
      { title: "SECRET TITLE A", baseItemId: "SECRET-BASE-ID", exactTitleCandidateCount: 0, exactTitleCandidates: [] },
      { title: "SECRET TITLE B", baseItemId: "SECRET-BASE-ID-2", exactTitleCandidateCount: 1, exactTitleCandidates: [{ existingBaseItemId: null, supplierListingId: "SECRET-SUPPLIER", supplierProductId: "p1", supplierVariantId: "v1", orderable: true, inventory: 4, priceDifference: 0 }] },
      { title: "SECRET TITLE C", baseItemId: "SECRET-BASE-ID-3", exactTitleCandidateCount: 2, exactTitleCandidates: [{ existingBaseItemId: "OTHER-BASE-ID", supplierListingId: null, supplierProductId: "p2", supplierVariantId: null, orderable: false, inventory: 0, priceDifference: 300 }, { existingBaseItemId: null, supplierListingId: "s2", supplierProductId: "p3", supplierVariantId: "v3", orderable: true, inventory: 1, priceDifference: null }] },
      { title: "SECRET TITLE D", baseItemId: "SECRET-BASE-ID-4", exactTitleCandidateCount: 25, exactTitleCandidates: Array.from({ length: 20 }, () => ({ existingBaseItemId: null, supplierListingId: "s", supplierProductId: "p", supplierVariantId: "v", orderable: true, inventory: 1, priceDifference: 0 })) },
    ],
  };
  await writeFile(input, JSON.stringify(report));
  const run = spawnSync(process.execPath, ["scripts/summarize-base-reconciliation.mjs", input], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"none": 1/);
  assert.match(run.stdout, /"exactlyOne": 1/);
  assert.match(run.stdout, /"multiple": 2/);
  assert.match(run.stdout, /"candidateAlreadyHasBaseItemId": 1/);
  assert.match(run.stdout, /"missingSupplierIdentity": 1/);
  assert.match(run.stdout, /"notOrderable": 1/);
  assert.match(run.stdout, /"stockUnknownOrNotPositive": 1/);
  assert.match(run.stdout, /"priceDifferencePresent": 1/);
  assert.match(run.stdout, /"detailsTruncatedAtTwenty": 1/);
  assert.doesNotMatch(run.stdout, /SECRET TITLE|SECRET-BASE-ID|SECRET-SUPPLIER|OTHER-BASE-ID/);

  await writeFile(input, JSON.stringify({ complete: false, baseItemCount: 0, items: [] }));
  const invalid = spawnSync(process.execPath, ["scripts/summarize-base-reconciliation.mjs", input], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /RECONCILIATION_REPORT_INCOMPLETE/);
  await writeFile(input, JSON.stringify({ complete: true, baseItemCount: 1, items: [{ exactTitleCandidates: [] }] }));
  const malformed = spawnSync(process.execPath, ["scripts/summarize-base-reconciliation.mjs", input], { encoding: "utf8" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /RECONCILIATION_CANDIDATE_COUNTS_INVALID/);
  console.log("BASE reconciliation aggregate diagnostics: 13 assertions passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
