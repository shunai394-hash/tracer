export function normalizedBaseExternalId(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = String(value).trim();
  return /^[0-9]+$/.test(id) ? id : null;
}

export function duplicateGroups(rows, getId) {
  const groups = new Map();
  for (const row of rows) {
    const id = getId(row);
    if (id === null) continue;
    groups.set(id, (groups.get(id) ?? 0) + 1);
  }
  return [...groups.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

export function reconcileBaseIds(dbRows, allBaseRows, visibleBaseRows) {
  const dbWithId = dbRows
    .map((row) => ({ ...row, normalizedBaseId: normalizedBaseExternalId(row.base_item_id) }))
    .filter((row) => row.normalizedBaseId !== null);
  const dbDuplicateIds = duplicateGroups(dbWithId, (row) => row.normalizedBaseId);
  const dbDuplicateSet = new Set(dbDuplicateIds.map((group) => group.id));
  const uniqueDbIds = new Set(
    dbWithId
      .filter((row) => !dbDuplicateSet.has(row.normalizedBaseId))
      .map((row) => row.normalizedBaseId),
  );

  const normalizeLiveRows = (rows) => rows
    .map((row) => ({ ...row, normalizedBaseId: normalizedBaseExternalId(row.item_id ?? row.id) }))
    .filter((row) => row.normalizedBaseId !== null);
  const allBase = normalizeLiveRows(allBaseRows);
  const visibleBase = normalizeLiveRows(visibleBaseRows);
  const allBaseIdSet = new Set(allBase.map((row) => row.normalizedBaseId));
  const visibleBaseIdSet = new Set(visibleBase.map((row) => row.normalizedBaseId));
  const liveDuplicateIds = duplicateGroups(allBase, (row) => row.normalizedBaseId);
  const matchedVisibleIds = [...visibleBaseIdSet].filter((id) => uniqueDbIds.has(id));
  const liveVisibleUnmatchedIds = [...visibleBaseIdSet].filter((id) => !uniqueDbIds.has(id)).sort();
  const dbIdsMissingFromBase = [...uniqueDbIds].filter((id) => !allBaseIdSet.has(id)).sort();
  const dbIdsForHiddenBaseItems = [...uniqueDbIds]
    .filter((id) => allBaseIdSet.has(id) && !visibleBaseIdSet.has(id))
    .sort();

  return {
    db: {
      shopListingsTotal: dbRows.length,
      rowsWithValidBaseExternalId: dbWithId.length,
      rowsWithoutValidBaseExternalId: dbRows.length - dbWithId.length,
      uniqueBaseExternalIds: new Set(dbWithId.map((row) => row.normalizedBaseId)).size,
      duplicateBaseExternalIdGroups: dbDuplicateIds.length,
      duplicateBaseExternalIds: dbDuplicateIds,
    },
    baseApi: {
      allItemsFetched: allBase.length,
      visibleItemsFetched: visibleBase.length,
      duplicateExternalIdGroups: liveDuplicateIds.length,
      duplicateExternalIds: liveDuplicateIds,
    },
    reconciliation: {
      visibleItemsMatchedToUniqueDbId: matchedVisibleIds.length,
      visibleItemsNotFoundInDb: liveVisibleUnmatchedIds.length,
      visibleItemIdsNotFoundInDb: liveVisibleUnmatchedIds,
      dbExternalIdsNotFoundInBase: dbIdsMissingFromBase.length,
      dbExternalIdsNotFoundInBaseList: dbIdsMissingFromBase,
      dbExternalIdsPresentButHiddenOnBase: dbIdsForHiddenBaseItems.length,
      dbExternalIdsPresentButHiddenOnBaseList: dbIdsForHiddenBaseItems,
      ambiguousDbExternalIdGroups: dbDuplicateIds.length,
      liveApiDuplicateExternalIdGroups: liveDuplicateIds.length,
    },
  };
}
