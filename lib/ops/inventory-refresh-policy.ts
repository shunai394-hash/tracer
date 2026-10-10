// Pure policy for the inventory-refresh cron (no server imports, so tests can
// load it directly).

const SALES_TEST_GATE_PASSED = "sales_test_gate_passed";

export type InventoryRefreshRow = {
  published?: unknown;
  selection_reasons?: unknown;
  supplier_name?: unknown;
  supplier_variant_id?: unknown;
  base_item_id?: unknown;
};

/**
 * Only listings that are already published and carry the canonical Sales Test
 * Gate marker are refreshed. A BASE item id alone is not a reason to touch an
 * unpublished listing; refresh never decides new listings or sale permission.
 */
export function isInventoryRefreshTarget(row: InventoryRefreshRow): boolean {
  return row.published === true
    && Array.isArray(row.selection_reasons)
    && row.selection_reasons.map(String).includes(SALES_TEST_GATE_PASSED)
    && typeof row.supplier_name === "string" && row.supplier_name.trim().length > 0
    && typeof row.supplier_variant_id === "string" && row.supplier_variant_id.trim().length > 0;
}

export type InventoryObservation =
  | { kind: "observed"; quantity: number }
  | { kind: "unavailable"; reason: string };

export type InventoryRefreshDecision = {
  inventory: number | null;
  inventoryConfirmed: boolean;
  orderable: boolean;
  baseStock: number;
  baseVisible: boolean;
  stopSale: boolean;
  reason: string;
};

/** Unknown, invalid or zero stock always stops the sale; only observed stock > 0 keeps it orderable. */
export function decideInventoryRefresh(observation: InventoryObservation): InventoryRefreshDecision {
  if (observation.kind === "unavailable") {
    return { inventory: null, inventoryConfirmed: false, orderable: false, baseStock: 0, baseVisible: false, stopSale: true, reason: observation.reason };
  }
  const quantity = observation.quantity;
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { inventory: null, inventoryConfirmed: false, orderable: false, baseStock: 0, baseVisible: false, stopSale: true, reason: "inventory_invalid" };
  }
  const stock = Math.floor(quantity);
  if (stock <= 0) {
    return { inventory: 0, inventoryConfirmed: true, orderable: false, baseStock: 0, baseVisible: false, stopSale: true, reason: "inventory_zero" };
  }
  return { inventory: stock, inventoryConfirmed: true, orderable: true, baseStock: stock, baseVisible: true, stopSale: false, reason: "inventory_observed" };
}
