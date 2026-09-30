// Pure CJ response parsers. Kept free of "server-only" so they can be
// exercised directly against recorded payloads.

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Per-warehouse totals. CJ's stock/queryByVid returns one row per warehouse
// with `storageNum` (legacy) and/or `totalInventoryNum`; older client code
// only looked for generic keys and therefore always resolved to null.
const TOTAL_KEYS = [
  "totalInventoryNum",
  "totalInventory",
  "storageNum",
  "inventoryNum",
  "warehouseInventoryNum",
  "availableStock",
  "stock",
  "inventory",
  "quantity",
] as const;

// When no total is present, CJ splits stock into its own warehouse and the
// factory's. Their sum is what can be ordered.
const PART_KEYS = [
  "cjInventoryNum",
  "factoryInventoryNum",
  "cjInventory",
  "factoryInventory",
] as const;

function warehouseQuantity(record: Record<string, unknown>): number | null {
  for (const key of TOTAL_KEYS) {
    const value = readNumber(record[key]);
    if (value !== null) return value;
  }
  const parts = PART_KEYS
    .map((key) => readNumber(record[key]))
    .filter((value): value is number => value !== null);
  return parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null;
}

/**
 * Sum the orderable quantity across every warehouse row in a CJ stock
 * payload. Returns null only when no row carries a recognizable quantity,
 * so "unknown" is never confused with "zero".
 */
export function parseCJStockData(data: unknown): number | null {
  if (typeof data === "number" || typeof data === "string") return readNumber(data);
  if (!data || typeof data !== "object") return null;

  if (!Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const direct = warehouseQuantity(record);
    if (direct !== null) return direct;
    // Wrapped shapes, e.g. { inventories: [...] } / { list: [...] }.
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        const nested = parseCJStockData(value);
        if (nested !== null) return nested;
      }
    }
    return null;
  }

  let total = 0;
  let seen = false;
  for (const row of data) {
    const quantity = typeof row === "object" && row !== null && !Array.isArray(row)
      ? warehouseQuantity(row as Record<string, unknown>)
      : readNumber(row);
    if (quantity === null) continue;
    total += Math.max(0, quantity);
    seen = true;
  }
  return seen ? total : null;
}

/** CJ's productImage is sometimes a JSON-encoded array of URLs. */
export function firstCJImageUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim());
    return typeof first === "string" ? first.trim() : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    try {
      return firstCJImageUrl(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return trimmed;
}
