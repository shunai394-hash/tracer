/**
 * Shopify inventory is a conservative storefront cap, not a mirror of the
 * supplier's warehouse quantity. Supplier inventory remains in TRACER and is
 * reverified separately; publishing 38,000 supplier units as Shopify stock
 * would misrepresent the merchant's independently controlled sellable stock.
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
