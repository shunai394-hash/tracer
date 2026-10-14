export type CatalogSnapshot = {
  shopListings: number;
  supplierListings: number;
};

export type CatalogRegression = {
  blocked: boolean;
  reasons: string[];
};

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read only snapshots emitted by patrol-ai; arbitrary or incomplete metadata is ignored. */
export function readPreviousCatalogSnapshot(metadata: unknown): CatalogSnapshot | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const report = metadata as Record<string, unknown>;
  const after = report.after;
  if (!after || typeof after !== "object" || Array.isArray(after)) return null;
  const snapshot = after as Record<string, unknown>;
  const shopListings = finiteCount(snapshot.shopListings);
  const supplierListings = finiteCount(snapshot.supplierListings);
  if (shopListings === null || supplierListings === null) return null;
  return { shopListings, supplierListings };
}

/**
 * Halt automation when core catalog counts unexpectedly collapse.
 * This is a safety stop, not a data-recovery mechanism.
 */
export function detectCatalogRegression(
  current: CatalogSnapshot,
  previous: CatalogSnapshot | null,
): CatalogRegression {
  if (!previous) return { blocked: false, reasons: [] };
  const reasons: string[] = [];
  if (previous.shopListings > 0 && current.shopListings === 0) {
    reasons.push(`shop_listings_dropped_to_zero:${previous.shopListings}->0`);
  }
  if (previous.supplierListings >= 1_000 && current.supplierListings < previous.supplierListings * 0.5) {
    reasons.push(`supplier_listings_dropped_over_50_percent:${previous.supplierListings}->${current.supplierListings}`);
  }
  return { blocked: reasons.length > 0, reasons };
}
