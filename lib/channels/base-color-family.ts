export type BaseColorFamilyCandidate = {
  id: string;
  supplierProductId: string | null;
};

export function getBaseColorFamilyBlockedIds(
  rows: BaseColorFamilyCandidate[],
  merchantHeldIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const supplierProductId = String(row.supplierProductId ?? "").trim();
    if (supplierProductId) counts.set(supplierProductId, (counts.get(supplierProductId) ?? 0) + 1);
  }
  const blocked = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    const supplierProductId = String(row.supplierProductId ?? "").trim();
    if (supplierProductId && (counts.get(supplierProductId) ?? 0) > 1 && !merchantHeldIds.has(id)) {
      blocked.add(id);
    }
  }
  return blocked;
}
