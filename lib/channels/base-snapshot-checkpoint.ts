export type BaseSnapshotCheckpoint = {
  nextOffset: number;
  pagesFetched: number;
  itemIds: string[];
};

export function itemIdOf(item: Record<string, unknown>): string {
  return String(item.item_id ?? "").trim();
}

/** Resume only when the caller still holds every row the checkpoint claims to have fetched. */
export function prepareSnapshotResume(
  priorItems: Record<string, unknown>[],
  checkpoint?: BaseSnapshotCheckpoint,
): { items: Record<string, unknown>[]; seen: Set<string>; pages: number; offset: number } {
  const priorIds = priorItems.map(itemIdOf);
  if (priorIds.some((id) => !id) || new Set(priorIds).size !== priorItems.length) {
    throw new Error("BASE_ITEMS_SNAPSHOT_ID_MISSING_OR_DUPLICATE");
  }
  const declaredIds = (checkpoint?.itemIds ?? []).map((id) => String(id).trim()).filter(Boolean);
  if (declaredIds.length > 0) {
    const priorSet = new Set(priorIds);
    if (declaredIds.length !== priorSet.size || declaredIds.some((id) => !priorSet.has(id))) {
      throw new Error("BASE_ITEMS_SNAPSHOT_CHECKPOINT_MISMATCH");
    }
  }
  return {
    items: priorItems.slice(),
    seen: new Set(priorIds),
    pages: Math.max(0, Math.floor(checkpoint?.pagesFetched ?? 0)),
    offset: Math.max(0, Math.floor(checkpoint?.nextOffset ?? 0)),
  };
}

/** Page append is idempotent: a repeated item id is skipped and never stored twice. */
export function appendSnapshotRows(
  items: Record<string, unknown>[],
  seen: Set<string>,
  rows: Record<string, unknown>[],
): { added: number; duplicates: number } {
  let added = 0;
  let duplicates = 0;
  for (const row of rows) {
    const id = itemIdOf(row);
    if (!id) throw new Error("BASE_ITEMS_SNAPSHOT_ID_MISSING_OR_DUPLICATE");
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    items.push(row);
    added += 1;
  }
  return { added, duplicates };
}
