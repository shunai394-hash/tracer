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

export function hasUniqueMarketplaceIdentity(candidateProductCount: number): boolean {
  return Number.isInteger(candidateProductCount) && candidateProductCount === 1;
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
    { name: "before_7_day_retry_is_deferred", expected: false, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.noUniqueMatch).toISOString() }, now) },
    { name: "at_7_day_boundary_is_due", expected: true, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now).toISOString() }, now) },
    { name: "before_24_hour_retry_is_deferred", expected: false, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.missingEvidence).toISOString() }, now) },
    { name: "at_24_hour_boundary_is_due", expected: true, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now).toISOString() }, now) },
    { name: "before_1_hour_retry_is_deferred", expected: false, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now + CJ_IDENTITY_RETRY_DELAYS_MS.processingError).toISOString() }, now) },
    { name: "at_1_hour_boundary_is_due", expected: true, actual: isCjIdentityReverifyDue({ next_identity_reverify_at: new Date(now).toISOString() }, now) },
    { name: "zero_candidates_never_link", expected: false, actual: hasUniqueMarketplaceIdentity(0) },
    { name: "multiple_candidates_never_link", expected: false, actual: hasUniqueMarketplaceIdentity(2) },
    { name: "one_candidate_can_pass_identity_gate", expected: true, actual: hasUniqueMarketplaceIdentity(1) },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
