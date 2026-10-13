import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const baseToken = process.env.BASE_ACCESS_TOKEN?.trim();

if (!supabaseUrl || !serviceRoleKey || !baseToken) {
  console.error(JSON.stringify({
    error: "missing_required_environment",
    required: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BASE_ACCESS_TOKEN"],
    writes: "none",
  }, null, 2));
  process.exit(2);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function normalizedId(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = String(value).trim();
  return /^[0-9]+$/.test(id) ? id : null;
}

async function fetchAllBaseItems(visible) {
  const all = [];
  const pageSize = 100;
  for (let offset = 0; offset <= 1_000_000; offset += pageSize) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      order: "modified",
      sort: "desc",
    });
    if (visible !== null) params.set("visible", visible ? "1" : "0");

    const response = await fetch(`https://api.thebase.in/1/items?${params}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${baseToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      // Do not treat auth, permission, pagination, or server errors as an empty shop.
      throw new Error(`base_items_http_${response.status}_offset_${offset}`);
    }
    const body = await response.json();
    const page = Array.isArray(body) ? body : body.items;
    if (!Array.isArray(page)) throw new Error(`base_items_unexpected_response_offset_${offset}`);
    all.push(...page);
    if (page.length < pageSize) return all;
  }
  throw new Error("base_items_pagination_limit_exceeded");
}

async function fetchAllDbListings() {
  const all = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("shop_listings")
      .select("id,base_item_id,published")
      .range(from, to);
    if (error) throw new Error(`shop_listings_read_failed_${error.code ?? "unknown"}`);
    const page = data ?? [];
    all.push(...page);
    if (page.length < pageSize) return all;
    if (all.length > 100_000) throw new Error("shop_listings_safety_limit_exceeded");
  }
}

function duplicateGroups(rows, getId) {
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

try {
  const [dbRows, allBaseRows, visibleBaseRows] = await Promise.all([
    fetchAllDbListings(),
    fetchAllBaseItems(null),
    fetchAllBaseItems(true),
  ]);

  const dbWithId = dbRows
    .map((row) => ({ ...row, normalizedBaseId: normalizedId(row.base_item_id) }))
    .filter((row) => row.normalizedBaseId !== null);
  const dbIdSet = new Set(dbWithId.map((row) => row.normalizedBaseId));
  const allBase = allBaseRows
    .map((row) => ({ ...row, normalizedBaseId: normalizedId(row.item_id ?? row.id) }))
    .filter((row) => row.normalizedBaseId !== null);
  const visibleBase = visibleBaseRows
    .map((row) => ({ ...row, normalizedBaseId: normalizedId(row.item_id ?? row.id) }))
    .filter((row) => row.normalizedBaseId !== null);
  const allBaseIdSet = new Set(allBase.map((row) => row.normalizedBaseId));
  const visibleBaseIdSet = new Set(visibleBase.map((row) => row.normalizedBaseId));

  const dbDuplicateIds = duplicateGroups(dbWithId, (row) => row.normalizedBaseId);
  const liveDuplicateIds = duplicateGroups(allBase, (row) => row.normalizedBaseId);
  const liveVisibleUnmatchedIds = [...visibleBaseIdSet].filter((id) => !dbIdSet.has(id)).sort();
  const dbIdsMissingFromBase = [...dbIdSet].filter((id) => !allBaseIdSet.has(id)).sort();
  const dbIdsForHiddenBaseItems = [...dbIdSet]
    .filter((id) => allBaseIdSet.has(id) && !visibleBaseIdSet.has(id))
    .sort();
  const uniqueDbIds = new Set(
    dbWithId
      .filter((row) => !dbDuplicateIds.some((group) => group.id === row.normalizedBaseId))
      .map((row) => row.normalizedBaseId),
  );
  const matchedVisibleIds = [...visibleBaseIdSet].filter((id) => uniqueDbIds.has(id));

  console.log(JSON.stringify({
    mode: "read_only",
    db: {
      shopListingsTotal: dbRows.length,
      rowsWithValidBaseExternalId: dbWithId.length,
      rowsWithoutValidBaseExternalId: dbRows.length - dbWithId.length,
      uniqueBaseExternalIds: dbIdSet.size,
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
    writes: "none",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : "audit_failed",
    interpretation: "No reconciliation counts are valid when the read-only audit errors.",
    writes: "none",
  }, null, 2));
  process.exit(1);
}
