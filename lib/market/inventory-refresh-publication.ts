export interface InventoryRefreshPublicationInput {
  inventory: number | null;
  wasPublished: boolean;
  durableSalesTestGatePassed: boolean;
}

export interface InventoryRefreshPublicationDecision {
  inventory: number | null;
  orderable: boolean;
  published: boolean;
  baseStock: number;
  baseVisible: boolean;
  reason: "inventory_unknown" | "inventory_zero" | "sales_test_gate_missing" | null;
}

/** Fail-closed policy: positive stock alone never republishes a listing. */
export function resolveInventoryRefreshPublication(
  input: InventoryRefreshPublicationInput,
): InventoryRefreshPublicationDecision {
  const inventory = typeof input.inventory === "number" && Number.isFinite(input.inventory)
    ? Math.max(0, Math.floor(input.inventory))
    : null;
  const orderable = inventory !== null && inventory > 0;
  const published = orderable && input.wasPublished && input.durableSalesTestGatePassed;
  return {
    inventory,
    orderable,
    published,
    baseStock: published ? inventory : 0,
    baseVisible: published,
    reason: inventory === null ? "inventory_unknown" : !orderable ? "inventory_zero" : !input.durableSalesTestGatePassed ? "sales_test_gate_missing" : null,
  };
}
