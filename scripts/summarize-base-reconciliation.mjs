import { readFile } from "node:fs/promises";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("RECONCILIATION_REPORT_PATH_REQUIRED");
const report = JSON.parse(await readFile(inputPath, "utf8"));
if (report.complete !== true || !Array.isArray(report.items) || report.baseItemCount !== report.items.length) {
  throw new Error("RECONCILIATION_REPORT_INCOMPLETE");
}

const items = report.items;
const count = (predicate) => items.filter(predicate).length;
const candidateCount = (item) => Number.isInteger(item.exactTitleCandidateCount) ? item.exactTitleCandidateCount : 0;
const candidates = (item) => Array.isArray(item.exactTitleCandidates) ? item.exactTitleCandidates : [];
const hasMissingSupplierIdentity = (row) =>
  !String(row.supplierListingId ?? "").trim() ||
  !String(row.supplierProductId ?? "").trim() ||
  !String(row.supplierVariantId ?? "").trim();

const summary = {
  complete: true,
  generatedAt: report.generatedAt ?? null,
  baseItemCount: report.baseItemCount,
  baseVisibleCount: report.baseVisibleCount,
  baseHiddenCount: report.baseHiddenCount,
  tracerListingCount: report.tracerListingCount,
  exactBaseIdMappedCount: report.exactBaseIdMappedCount,
  baseItemsWithoutExactMappingCount: report.baseItemsWithoutExactMappingCount,
  titleCandidateBuckets: {
    none: count((item) => candidateCount(item) === 0),
    exactlyOne: count((item) => candidateCount(item) === 1),
    multiple: count((item) => candidateCount(item) > 1),
  },
  candidateDiagnostics: {
    candidateAlreadyHasBaseItemId: count((item) => candidates(item).some((row) => String(row.existingBaseItemId ?? "").trim() !== "")),
    missingSupplierIdentity: count((item) => candidates(item).some(hasMissingSupplierIdentity)),
    notOrderable: count((item) => candidates(item).some((row) => row.orderable !== true)),
    stockUnknownOrNotPositive: count((item) => candidates(item).some((row) => row.inventory == null || !Number.isFinite(Number(row.inventory)) || Number(row.inventory) <= 0)),
    priceDifferencePresent: count((item) => candidates(item).some((row) => row.priceDifference != null && Number(row.priceDifference) !== 0)),
    detailsTruncatedAtTwenty: count((item) => candidateCount(item) > candidates(item).length),
  },
  tracerListingsWithoutBaseItemIdCount: report.tracerListingsWithoutBaseItemIdCount,
  duplicateBaseItemIdGroupsInTracer: report.duplicateBaseItemIdGroupsInTracer,
  note: "Aggregate diagnostics only. Counts may overlap. Candidate details are capped at 20 per BASE item; no item titles, IDs, supplier IDs, or per-item data are published. Exact-title candidates are not verified mappings. No mappings, listings, or orders were changed.",
};

const json = JSON.stringify(summary, null, 2);
process.stdout.write("# TRACER BASE mapping audit\n\nRead-only aggregate reconciliation. No BASE listing, TRACER mapping, or order was modified.\n\n```json\n" + json + "\n```\n");
