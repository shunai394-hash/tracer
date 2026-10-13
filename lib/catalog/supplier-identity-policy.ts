export type SupplierIdentityPolicyInput = {
  candidateCount: number;
  candidateProductId: string | null;
  candidateSupplierProductId: string | null;
  candidateVariantId: string | null;
  candidateSellingCurrency: string | null;
  sourceIdentityStatus: string | null;
  sourceProductId: string | null;
  sourceSupplierProductId: string | null;
  sourceVariantId: string | null;
  sourceCurrency: string | null;
};

/** Pure fail-closed policy used by both downstream publication channels. */
export function isSupplierIdentityEligible(input: SupplierIdentityPolicyInput): boolean {
  if (input.candidateCount !== 1) return false;
  if (input.sourceIdentityStatus !== "linked") return false;
  const canonicalProductId = input.candidateProductId?.trim() ?? "";
  const sourceProductId = input.sourceProductId?.trim() ?? "";
  const listingSupplierProductId = input.candidateSupplierProductId?.trim() ?? "";
  const sourceSupplierProductId = input.sourceSupplierProductId?.trim() ?? "";
  const listingVariantId = input.candidateVariantId?.trim() ?? "";
  const sourceVariantId = input.sourceVariantId?.trim() ?? "";
  const sellingCurrency = input.candidateSellingCurrency?.trim().toUpperCase() ?? "";
  const sourceCurrency = input.sourceCurrency?.trim().toUpperCase() ?? "";
  return Boolean(
    canonicalProductId &&
    sourceProductId === canonicalProductId &&
    listingSupplierProductId &&
    sourceSupplierProductId === listingSupplierProductId &&
    listingVariantId &&
    sourceVariantId === listingVariantId &&
    sellingCurrency &&
    sourceCurrency === sellingCurrency
  );
}
