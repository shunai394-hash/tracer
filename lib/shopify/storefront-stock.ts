/**
 * Storefront stock is a conservative cap, not a mirror of a supplier warehouse.
 * TRACER retains the verified supplier inventory separately and rechecks it
 * before procurement; public Shopify stock must not expose supplier-scale counts.
 */
export function toStorefrontStockQuantity(supplierInventory: unknown, configuredCap?: unknown): number {
  const source = typeof supplierInventory === "number"
    ? supplierInventory
    : typeof supplierInventory === "string" && supplierInventory.trim()
      ? Number(supplierInventory)
      : Number.NaN;
  if (!Number.isFinite(source) || source <= 0) return 0;

  const parsedCap = typeof configuredCap === "number"
    ? configuredCap
    : typeof configuredCap === "string" && configuredCap.trim()
      ? Number(configuredCap)
      : 10;
  const cap = Number.isFinite(parsedCap) && parsedCap > 0
    ? Math.min(100, Math.max(1, Math.floor(parsedCap)))
    : 10;
  return Math.min(Math.floor(source), cap);
}
