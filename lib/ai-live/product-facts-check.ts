const FACT_MAX_AGE_MS = 15 * 60 * 1000;

export type SellableProductFact = {
  id: string;
  sellingPrice: number;
  inventory: number;
  inStock: boolean;
  updatedAt: string;
  supplierConfirmed: boolean;
  supplierFingerprint: string | null;
};

export type ExpectedProductFact = {
  productId: string;
  sellingPrice: number;
  inventory: number;
  supplierFingerprint: string;
};

export type ProductFactResult =
  | { ok: true }
  | { ok: false; errorCode: "stale_product_facts" | "inventory_unverified" | "product_facts_mismatch" | "supplier_fingerprint_mismatch" };

function sameId(left: string, right: string): boolean {
  return left === right;
}

/**
 * Compares a job segment with one read-only sellable product record.
 * A missing record, an old catalog row, or a different price, stock count,
 * or supplier fingerprint stops the introduction.
 */
export function compareProductFacts(
  expected: ExpectedProductFact,
  actual: SellableProductFact | null,
  nowMs: number,
): ProductFactResult {
  if (!actual) return { ok: false, errorCode: "product_facts_mismatch" };
  const updatedAt = Date.parse(actual.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt > nowMs + 60_000 || nowMs - updatedAt > FACT_MAX_AGE_MS) {
    return { ok: false, errorCode: "stale_product_facts" };
  }
  if (!sameId(actual.id, expected.productId) || actual.sellingPrice !== expected.sellingPrice) {
    return { ok: false, errorCode: "product_facts_mismatch" };
  }
  if (actual.inStock !== true || !Number.isInteger(actual.inventory) || actual.inventory <= 0 || actual.inventory !== expected.inventory) {
    return { ok: false, errorCode: "inventory_unverified" };
  }
  if (actual.supplierConfirmed !== true || actual.supplierFingerprint !== expected.supplierFingerprint) {
    return { ok: false, errorCode: "supplier_fingerprint_mismatch" };
  }
  return { ok: true };
}
