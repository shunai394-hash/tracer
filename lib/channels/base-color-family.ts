/**
 * BASE variations expose exact option IDs, labels, stock, and identifiers.
 * Images are an item-level gallery (img1–img20), not dynamically bound to each
 * variation. TRACER may publish verified families with the complete color gallery.
 */
export const BASE_VARIATION_IMAGE_BINDING = "item_gallery_only" as const;

export type BaseColorFamilyCandidate = {
  id: string;
  supplierCode: string | null;
  supplierProductId: string | null;
};

export function getBaseColorFamilyBlockedIds(
  rows: BaseColorFamilyCandidate[],
  merchantHeldIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const supplierCode = String(row.supplierCode ?? "").trim().toLowerCase();
    const supplierProductId = String(row.supplierProductId ?? "").trim();
    if (supplierCode && supplierProductId) {
      const key = JSON.stringify([supplierCode, supplierProductId]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const blocked = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    const supplierCode = String(row.supplierCode ?? "").trim().toLowerCase();
    const supplierProductId = String(row.supplierProductId ?? "").trim();
    const key = JSON.stringify([supplierCode, supplierProductId]);
    if (supplierCode && supplierProductId && (counts.get(key) ?? 0) > 1 && !merchantHeldIds.has(id)) {
      blocked.add(id);
    }
  }
  return blocked;
}
