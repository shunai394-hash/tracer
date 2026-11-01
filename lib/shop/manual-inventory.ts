export function isManualInventoryListing(row: { manual_inventory?: unknown }): boolean {
  return row.manual_inventory === true;
}

/**
 * Merchant-owned stock is the exact physical quantity, not a supplier
 * storefront cap. Invalid values are rejected; zero is a valid published
 * out-of-stock state.
 */
export function manualInventoryQuantity(row: { inventory?: unknown }): number | null {
  const value = row.inventory;
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const quantity = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : null;
}
