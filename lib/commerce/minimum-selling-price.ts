export const MINIMUM_SELLING_PRICE_JPY = 2500;

export function meetsMinimumSellingPrice(value: unknown): boolean {
  const price = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(price) && price >= MINIMUM_SELLING_PRICE_JPY;
}
