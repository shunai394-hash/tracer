export type ReconciliationConfidenceInput = {
  score: number;
  topScore: number;
  topCandidateCount: number;
  evidence: string[];
  baseSupplierProductId: string;
  baseSupplierVariantId: string;
  rowSupplierProductId: string;
  rowSupplierVariantId: string;
  duplicateIdentityCount: number;
};

export function isHighConfidenceReconciliationCandidate(input: ReconciliationConfidenceInput): boolean {
  if (input.score <= 0 || input.score !== input.topScore || input.topCandidateCount !== 1) return false;
  if (!input.evidence.some((entry) => entry === "supplier_product_id_exact" || entry === "supplier_variant_id_exact")) return false;

  const baseProduct = input.baseSupplierProductId.trim();
  const baseVariant = input.baseSupplierVariantId.trim();
  const rowProduct = input.rowSupplierProductId.trim();
  const rowVariant = input.rowSupplierVariantId.trim();

  // Product identity alone is insufficient when BASE specifies a variant.
  if (baseProduct && rowProduct && baseProduct === rowProduct && baseVariant && baseVariant !== rowVariant) return false;
  // Contradictory non-empty supplier identifiers cannot support a high-confidence label.
  if (baseProduct && rowProduct && baseProduct !== rowProduct) return false;
  if (baseVariant && rowVariant && baseVariant !== rowVariant) return false;
  if (input.duplicateIdentityCount > 1) return false;
  return true;
}
