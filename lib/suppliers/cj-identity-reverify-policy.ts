export const CJ_IDENTITY_RETRY_DELAYS_MS = {
  noUniqueMatch: 7 * 24 * 60 * 60 * 1000,
  missingEvidence: 24 * 60 * 60 * 1000,
  processingError: 60 * 60 * 1000,
} as const;

export function isCjIdentityReverifyCandidate(args: {
  verificationStatus: string | null;
  identityMethod: string | null;
  supplierVariantId: string | null;
}): boolean {
  return ["unverified", "retryable", "verified"].includes(args.verificationStatus ?? "")
    && ["supply_discovered", "none"].includes(args.identityMethod ?? "")
    && Boolean(args.supplierVariantId?.trim());
}

export function isCjIdentityReverifyDue(metadata: unknown, nowMs = Date.now()): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const nextAt = typeof record.next_identity_reverify_at === "string"
    ? Date.parse(record.next_identity_reverify_at)
    : NaN;
  return !Number.isFinite(nextAt) || nextAt <= nowMs;
}

export function supplierBarcodeAudit(value: unknown, isValidGtIn: boolean): {
  variant_barcode_raw: string | null;
  variant_barcode_validation: "missing" | "valid_gs1_check_digit" | "invalid_format_or_check_digit";
} {
  const raw = typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    variant_barcode_raw: raw,
    variant_barcode_validation: raw === null
      ? "missing"
       : isValidGtIn
        ? "valid_gs1_check_digit"
        : "invalid_format_or_check_digit",
  };
}

export function hasExactCurrentRequestVariantSet(
  rows: Array<{ id: string; supply_product_id: string }>,
  requestedVariantIds: string[],
): boolean {
  const requested = requestedVariantIds.filter((id) => typeof id === "string" && id.trim());
  if (requested.length === 0 || new Set(requested).size !== requested.length) return false;
  const actual = rows.map((row) => row.id);
  if (actual.length !== requested.length || new Set(actual).size !== actual.length) return false;
  if (!requested.every((id) => actual.includes(id))) return false;
  return new Set(rows.map((row) => row.supply_product_id)).size === 1;
}

export function onlyCurrentRequestVariants<T extends { id: string }>(
  rows: T[],
  requestedVariantIds: string[],
): T[] {
  const requested = new Set(requestedVariantIds.filter((id) => typeof id === "string" && id.trim()));
  return rows.filter((row) => requested.has(row.id));
}

export function shouldSyncInternalSupplyCatalog(args: {
  bestsellerId: string | null;
  submittedVariantCount: number;
  variantWriteErrorCount: number;
  successfulVariantWriteCount: number;
}): boolean {
  return Boolean(args.bestsellerId)
    && Number.isInteger(args.submittedVariantCount)
    && args.submittedVariantCount > 0
    && args.variantWriteErrorCount === 0
    && args.successfulVariantWriteCount === args.submittedVariantCount;
}

export function hasUniqueIdentitySelection(candidateCount: number, exactMatchCount: number): boolean {
  return Number.isInteger(candidateCount) && candidateCount > 0
    && (candidateCount === 1 || (Number.isInteger(exactMatchCount) && exactMatchCount === 1));
}

export function hasUniqueMarketplaceIdentity(candidateProductCount: number): boolean {
  return Number.isInteger(candidateProductCount) && candidateProductCount === 1;
}

export type InternalProductCandidateStatus =
  | "no_product_candidate"
  | "unique_product_candidate"
  | "ambiguous_product";

/**
 * Keep operational telemetry honest: zero eligible products is a missing
 * candidate, not an ambiguous match. Invalid counts fail closed as ambiguous.
 */
export function internalProductCandidateStatus(candidateCount: number): InternalProductCandidateStatus {
  if (!Number.isInteger(candidateCount) || candidateCount < 0) return "ambiguous_product";
  if (candidateCount === 0) return "no_product_candidate";
  if (candidateCount === 1) return "unique_product_candidate";
  return "ambiguous_product";
}

export function supplierListingStateForIdentity(linkVerified: boolean) {
  return linkVerified
    ? { identity_status: "linked", configured: true, orderable: true }
    : { identity_status: "pending", configured: false, orderable: false };
}

export type InternalSupplyLinkIdentity = {
  bestseller_id: unknown;
  supply_product_id: unknown;
  supply_variant_id: unknown;
  identity_method: unknown;
  identity_confidence: unknown;
  identity_rationale: unknown;
  status: unknown;
};

export function isVerifiedInternalSupplyLink(
  existing: InternalSupplyLinkIdentity | null,
  expected: InternalSupplyLinkIdentity,
): boolean {
  if (!existing) return false;
  const expectedConfidence = Number(expected.identity_confidence);
  const existingConfidence = Number(existing.identity_confidence);
  return String(existing.bestseller_id) === String(expected.bestseller_id)
    && String(existing.supply_product_id) === String(expected.supply_product_id)
    && String(existing.supply_variant_id) === String(expected.supply_variant_id)
    && existing.identity_method === expected.identity_method
    && Number.isFinite(expectedConfidence)
    && Number.isFinite(existingConfidence)
    && existingConfidence === expectedConfidence
    && existing.identity_rationale === expected.identity_rationale
    && existing.status === expected.status;
}

export function verifyCjIdentityReverifyPolicyInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const cases = [
    { name: "verified_unlinked_is_candidate", expected: true, actual: isCjIdentityReverifyCandidate({ verificationStatus: "verified", identityMethod: "supply_discovered", supplierVariantId: "variant-1" }) },
    { name: "verified_linked_is_not_candidate", expected: false, actual: isCjIdentityReverifyCandidate({ verificationStatus: "verified", identityMethod: "gtin", supplierVariantId: "variant-1" }) },
    { name: "missing_variant_is_not_candidate", expected: false, actual: isCjIdentityReverifyCandidate({ verificationStatus: "verified", identityMethod: "supply_discovered", supplierVariantId: null }) },
    { name: "no_retry_timestamp_is_due", expected: true, actual: isCjIdentityReverifyDue({}, now) },
    { name: "one_millisecond_before_7_day_boundary_is_deferred", expected: false, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.noUniqueMatch).toISOString() }, now + CJ_IDENTITY_RETRY_DELAYS_MS.noUniqueMatch - 1) },
    { name: "at_7_day_boundary_is_due", expected: true, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.noUniqueMatch).toISOString() }, now + CJ_IDENTITY_RETRY_DELAYS_MS.noUniqueMatch) },
    { name: "one_millisecond_before_24_hour_boundary_is_deferred", expected: false, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.missingEvidence).toISOString() }, now + CJ_IDENTITY_RETRY_DELAYS_MS.missingEvidence - 1) },
    { name: "at_24_hour_boundary_is_due", expected: true, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.missingEvidence).toISOString() }, now + CJ_IDENTITY_RETRY_DELAYS_MS.missingEvidence) },
    { name: "one_millisecond_before_1_hour_boundary_is_deferred", expected: false, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.processingError).toISOString() }, now + CJ_IDENTITY_RETRY_DELAYS_MS.processingError - 1) },
    { name: "at_1_hour_boundary_is_due", expected: true, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.processingError).toISOString() }, now + CJ_IDENTITY_RETRY_DELAYS_MS.processingError) },
    { name: "invalid_gtin_is_rejected_but_raw_value_is_retained", expected: true, actual: (() => { const raw = "1598446591114"; const audit = supplierBarcodeAudit(raw, false); return audit.variant_barcode_raw === raw && audit.variant_barcode_validation === "invalid_format_or_check_digit"; })() },
    { name: "valid_gtin_is_classified_but_not_itself_linked", expected: true, actual: (() => { const audit = supplierBarcodeAudit("4006381333931", true); return audit.variant_barcode_validation === "valid_gs1_check_digit" && !hasUniqueMarketplaceIdentity(0); })() },
    { name: "stale_existing_variant_is_excluded_from_current_request_scope", expected: true, actual: JSON.stringify(onlyCurrentRequestVariants([{ id: "old-variant" }, { id: "written-this-request" }], ["written-this-request"]).map((row) => row.id)) === JSON.stringify(["written-this-request"]) },
    { name: "empty_current_request_variant_scope_selects_nothing", expected: true, actual: onlyCurrentRequestVariants([{ id: "old-variant" }], []).length === 0 },
    { name: "exact_variant_scope_accepts_only_complete_single_product_set", expected: true, actual: hasExactCurrentRequestVariantSet([{ id: "v1", supply_product_id: "p1" }, { id: "v2", supply_product_id: "p1" }], ["v1", "v2"]) },
    { name: "incomplete_variant_scope_is_rejected", expected: false, actual: hasExactCurrentRequestVariantSet([{ id: "v1", supply_product_id: "p1" }], ["v1", "v2"]) },
    { name: "cross_product_variant_scope_is_rejected", expected: false, actual: hasExactCurrentRequestVariantSet([{ id: "v1", supply_product_id: "p1" }, { id: "v2", supply_product_id: "p2" }], ["v1", "v2"]) },
    { name: "duplicate_requested_variant_ids_are_rejected", expected: false, actual: hasExactCurrentRequestVariantSet([{ id: "v1", supply_product_id: "p1" }], ["v1", "v1"]) },

    { name: "missing_variants_block_catalog_sync", expected: false, actual: shouldSyncInternalSupplyCatalog({ bestsellerId: "market-1", submittedVariantCount: 0, variantWriteErrorCount: 0, successfulVariantWriteCount: 0 }) },
    { name: "partial_variant_failure_blocks_catalog_sync", expected: false, actual: shouldSyncInternalSupplyCatalog({ bestsellerId: "market-1", submittedVariantCount: 2, variantWriteErrorCount: 1, successfulVariantWriteCount: 1 }) },
    { name: "incomplete_variant_writes_block_catalog_sync", expected: false, actual: shouldSyncInternalSupplyCatalog({ bestsellerId: "market-1", submittedVariantCount: 2, variantWriteErrorCount: 0, successfulVariantWriteCount: 1 }) },
    { name: "complete_variant_writes_allow_server_side_gate_to_run", expected: true, actual: shouldSyncInternalSupplyCatalog({ bestsellerId: "market-1", submittedVariantCount: 2, variantWriteErrorCount: 0, successfulVariantWriteCount: 2 }) },
    { name: "missing_marketplace_reference_blocks_catalog_sync", expected: false, actual: shouldSyncInternalSupplyCatalog({ bestsellerId: null, submittedVariantCount: 1, variantWriteErrorCount: 0, successfulVariantWriteCount: 1 }) },
    { name: "multiple_variants_without_unique_identifier_match_are_rejected", expected: false, actual: hasUniqueIdentitySelection(3, 0) },
    { name: "multiple_variants_with_one_exact_identifier_match_select_one", expected: true, actual: hasUniqueIdentitySelection(3, 1) },
    { name: "multiple_variants_with_duplicate_exact_matches_are_rejected", expected: false, actual: hasUniqueIdentitySelection(3, 2) },
    { name: "zero_candidates_never_link", expected: false, actual: hasUniqueMarketplaceIdentity(0) },
    { name: "multiple_candidates_never_link", expected: false, actual: hasUniqueMarketplaceIdentity(2) },
    { name: "one_candidate_can_pass_identity_gate", expected: true, actual: hasUniqueMarketplaceIdentity(1) },
    { name: "zero internal product candidates are reported as missing, not ambiguous", expected: true, actual: internalProductCandidateStatus(0) === "no_product_candidate" },
    { name: "one internal product candidate is uniquely classified", expected: true, actual: internalProductCandidateStatus(1) === "unique_product_candidate" },
    { name: "multiple internal product candidates remain ambiguous", expected: true, actual: internalProductCandidateStatus(2) === "ambiguous_product" },
    { name: "invalid internal product candidate count fails closed", expected: true, actual: internalProductCandidateStatus(-1) === "ambiguous_product" },
    { name: "internal link readback accepts exact persisted identity", expected: true, actual: isVerifiedInternalSupplyLink({ bestseller_id: "b1", supply_product_id: "p1", supply_variant_id: "v1", identity_method: "exact_gtin", identity_confidence: 1, identity_rationale: "exact barcode", status: "verified" }, { bestseller_id: "b1", supply_product_id: "p1", supply_variant_id: "v1", identity_method: "exact_gtin", identity_confidence: 1, identity_rationale: "exact barcode", status: "verified" }) },
    { name: "internal link readback rejects mismatched variant", expected: false, actual: isVerifiedInternalSupplyLink({ bestseller_id: "b1", supply_product_id: "p1", supply_variant_id: "wrong-v", identity_method: "exact_gtin", identity_confidence: 1, identity_rationale: "exact barcode", status: "verified" }, { bestseller_id: "b1", supply_product_id: "p1", supply_variant_id: "v1", identity_method: "exact_gtin", identity_confidence: 1, identity_rationale: "exact barcode", status: "verified" }) },
    { name: "internal link readback rejects mismatched identity rationale", expected: false, actual: isVerifiedInternalSupplyLink({ bestseller_id: "b1", supply_product_id: "p1", supply_variant_id: "v1", identity_method: "exact_gtin", identity_confidence: 1, identity_rationale: "different evidence", status: "verified" }, { bestseller_id: "b1", supply_product_id: "p1", supply_variant_id: "v1", identity_method: "exact_gtin", identity_confidence: 1, identity_rationale: "exact barcode", status: "verified" }) },
    { name: "internal link readback rejects missing row", expected: false, actual: isVerifiedInternalSupplyLink(null, { bestseller_id: "b1", supply_product_id: "p1", supply_variant_id: "v1", identity_method: "exact_gtin", identity_confidence: 1, identity_rationale: "exact barcode", status: "verified" }) },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
