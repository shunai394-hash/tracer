import { womenProductPriority } from "./womens-priority.ts";

const NON_PHYSICAL_PRODUCT_PATTERNS = [
  /商品券/i,
  /デジタルギフト/i,
  /ギフトカード/i,
  /gift\s*card/i,
  /e[-\s]?gift/i,
  /voucher/i,
  /coupon/i,
  /download/i,
  /digital\s+(gift|product)/i,
];

export function isNonPhysicalProduct(title: string, category = ""): boolean {
  const evidence = `${title} ${category}`.normalize("NFKC").trim();
  return NON_PHYSICAL_PRODUCT_PATTERNS.some((pattern) => pattern.test(evidence));
}

export function filterSupplierCandidateIds(
  candidateIds: string[],
  candidateRows: Array<{ id: string | number; title?: string | null; category?: string | null }> | null,
): { supplierCandidateIds: string[]; inputCount: number; eligibleCount: number; skippedNonWomenOrNonPhysicalCount: number } {
  const candidateById = new Map(
    (candidateRows ?? []).map((row) => [String(row.id), row]),
  );
  const supplierCandidateIds = candidateIds.filter((id) => {
    const row = candidateById.get(id);
    if (!row) return false;
    const title = String(row.title ?? "").normalize("NFKC").trim();
    const category = String(row.category ?? "");
    if (!title || isNonPhysicalProduct(title, category)) return false;
    return womenProductPriority({ title, category }).isWomenFocused;
  });

  return {
    supplierCandidateIds,
    inputCount: candidateIds.length,
    eligibleCount: supplierCandidateIds.length,
    skippedNonWomenOrNonPhysicalCount: candidateIds.length - supplierCandidateIds.length,
  };
}
