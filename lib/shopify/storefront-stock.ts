/**
 * One shared cap for TRACER, BASE, and Shopify. A legacy channel-specific cap
 * may be used only as a fallback so channel inventories cannot drift.
 */
export function getStorefrontStockCap(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.STOREFRONT_STOCK_CAP ?? env.SHOPIFY_STOREFRONT_STOCK_CAP ?? env.BASE_STOREFRONT_STOCK_CAP;
}

/**
 * Supplier inventory is not a mirror of merchant-controlled storefront stock.
 * All channels use this same conservative cap and reverify supplier stock
 * separately before procurement.
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
