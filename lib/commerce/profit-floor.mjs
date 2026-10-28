/**
 * Temporary commerce eligibility floor shared by TRACER storefront and all
 * downstream sales channels (BASE, Shopify, NEWFIND).
 * expected_profit is JPY after supplier cost, Japan shipping, and channel fee.
 */
export const MINIMUM_EXPECTED_PROFIT_JPY = 2500;

export function meetsMinimumExpectedProfit(value: unknown): boolean {
  const profit = typeof value === "number" ? value : Number(value);
  return Number.isFinite(profit) && profit >= MINIMUM_EXPECTED_PROFIT_JPY;
}

export function minimumProfitBlockReason(value: unknown): string | null {
  return meetsMinimumExpectedProfit(value)
    ? null
    : `expected_profit_below_minimum_${MINIMUM_EXPECTED_PROFIT_JPY}_jpy`;
}
