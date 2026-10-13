/**
 * Deterministic bulk-catalog dry-run planner.
 * No database/provider I/O and no publication side effects.
 */
import { evaluatePublication, type PublicationEvidence } from "./contracts";

export type BulkCatalogCandidate = {
  productId: string;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  evidence: PublicationEvidence;
};

export type BulkCatalogPlan = {
  requestedLimit: number;
  inputCount: number;
  uniqueProductCount: number;
  duplicateProductIds: string[];
  duplicateSupplierVariants: string[];
  eligibleProductIds: string[];
  rejected: Array<{ productId: string; blockers: string[] }>;
  selectedProductIds: string[];
  counts: { eligible: number; rejected: number; selected: number; targetShortfall: number };
  writeMode: "dry_run_only";
};

/** Always returns a dry-run plan; callers cannot switch this function to write mode. */
export function planBulkCatalogImport(
  candidates: BulkCatalogCandidate[],
  requestedLimit = 1200,
): BulkCatalogPlan {
  const safeLimit = Number.isInteger(requestedLimit) ? Math.max(0, Math.min(requestedLimit, 1200)) : 0;
  const productCounts = new Map<string, number>();
  const variantCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const productId = clean(candidate?.productId);
    const supplierProductId = clean(candidate?.supplierProductId);
    const supplierVariantId = clean(candidate?.supplierVariantId);
    if (productId) productCounts.set(productId, (productCounts.get(productId) ?? 0) + 1);
    if (supplierProductId && supplierVariantId) {
      const key = supplierProductId + "::" + supplierVariantId;
      variantCounts.set(key, (variantCounts.get(key) ?? 0) + 1);
    }
  }

  const duplicateProductIds = [...productCounts].filter(([, count]) => count > 1).map(([id]) => id).sort();
  const duplicateSupplierVariants = [...variantCounts].filter(([, count]) => count > 1).map(([key]) => key).sort();
  const eligibleProductIds: string[] = [];
  const rejected: BulkCatalogPlan["rejected"] = [];

  for (const candidate of candidates) {
    const productId = clean(candidate?.productId);
    const supplierProductId = clean(candidate?.supplierProductId);
    const supplierVariantId = clean(candidate?.supplierVariantId);
    if (!productId) {
      rejected.push({ productId: "", blockers: ["internal_product_id_missing"] });
      continue;
    }
    const blockers: string[] = [];
    if ((productCounts.get(productId) ?? 0) > 1) blockers.push("duplicate_internal_product_id");
    if (!supplierProductId || !supplierVariantId) blockers.push("supplier_product_or_variant_id_missing");
    const variantKey = supplierProductId && supplierVariantId ? supplierProductId + "::" + supplierVariantId : "";
    if (variantKey && (variantCounts.get(variantKey) ?? 0) > 1) blockers.push("duplicate_supplier_variant");

    const decision = candidate.evidence && typeof candidate.evidence === "object"
      ? evaluatePublication(candidate.evidence)
      : { eligible: false, blockers: ["publication_evidence_missing"] };
    blockers.push(...decision.blockers);
    const uniqueBlockers = [...new Set(blockers)].sort();
    if (uniqueBlockers.length) rejected.push({ productId, blockers: uniqueBlockers });
    else eligibleProductIds.push(productId);
  }

  const selectedProductIds = eligibleProductIds.slice(0, safeLimit);
  return {
    requestedLimit: safeLimit,
    inputCount: candidates.length,
    uniqueProductCount: productCounts.size,
    duplicateProductIds,
    duplicateSupplierVariants,
    eligibleProductIds,
    rejected,
    selectedProductIds,
    counts: {
      eligible: eligibleProductIds.length,
      rejected: rejected.length,
      selected: selectedProductIds.length,
      targetShortfall: Math.max(0, safeLimit - selectedProductIds.length),
    },
    writeMode: "dry_run_only",
  };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
