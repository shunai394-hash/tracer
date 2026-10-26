/**
 * Per-variant ad economics from stored commerce prices. Pure: no I/O.
 * expected_profit is price minus supplier cost, supplier shipping and channel
 * fee, before any advertising, so:
 *   break-even ROAS = selling price / profit   (revenue per ad yen to break even)
 *   max CPA        = profit                    (ad yen per purchase to break even)
 * Rows without a positive price and profit are reported, never scored.
 */

export type UnitEconomicsInput = {
  variantId: string;
  title: string | null;
  sellingPrice: number;
  feeAmount: number;
  expectedProfit: number;
  inventory: number | null;
  offerFresh: boolean;
  liveOnShopify: boolean;
  liveOnBase: boolean;
};

export type UnitEconomicsRow = UnitEconomicsInput & {
  supplierCostAndShipping: number;
  marginRate: number;
  breakEvenRoas: number;
  maxCpaJpy: number;
};

export function unitEconomics(row: UnitEconomicsInput): UnitEconomicsRow | null {
  const price = Number(row.sellingPrice);
  const profit = Number(row.expectedProfit);
  const fee = Number(row.feeAmount);
  if (!(price > 0) || !(profit > 0) || !Number.isFinite(fee) || fee < 0 || profit >= price) return null;
  return {
    ...row,
    supplierCostAndShipping: price - fee - profit,
    marginRate: profit / price,
    breakEvenRoas: price / profit,
    maxCpaJpy: profit,
  };
}

const percentile = (sorted: number[], p: number) => {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
};

export function summarizeUnitEconomics(inputs: UnitEconomicsInput[], top = 20) {
  const scored = inputs.map(unitEconomics).filter((row): row is UnitEconomicsRow => row !== null);
  const sellable = scored.filter((row) => row.liveOnShopify && row.offerFresh && Number(row.inventory) > 0);
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { min: sorted[0] ?? null, p25: percentile(sorted, 0.25), median: percentile(sorted, 0.5), p75: percentile(sorted, 0.75), max: sorted.at(-1) ?? null };
  };
  const priceBands = [
    { band: "<2000", min: 0, max: 2000 },
    { band: "2000-3999", min: 2000, max: 4000 },
    { band: "4000-6999", min: 4000, max: 7000 },
    { band: "7000-9999", min: 7000, max: 10000 },
    { band: ">=10000", min: 10000, max: Number.POSITIVE_INFINITY },
  ].map((band) => {
    const rows = sellable.filter((row) => row.sellingPrice >= band.min && row.sellingPrice < band.max);
    return { band: band.band, count: rows.length, medianMaxCpaJpy: stats(rows.map((row) => row.maxCpaJpy)).median };
  });
  const pick = (row: UnitEconomicsRow) => ({
    variantId: row.variantId, title: row.title, sellingPrice: row.sellingPrice,
    supplierCostAndShipping: row.supplierCostAndShipping, feeAmount: row.feeAmount,
    maxCpaJpy: row.maxCpaJpy, breakEvenRoas: Math.round(row.breakEvenRoas * 100) / 100,
    marginRate: Math.round(row.marginRate * 1000) / 1000, inventory: row.inventory, liveOnBase: row.liveOnBase,
  });
  return {
    definition: "breakEvenRoas = sellingPrice / expectedProfit; maxCpaJpy = expectedProfit (profit after supplier cost, supplier shipping and channel fee, before ads)",
    counts: { input: inputs.length, scored: scored.length, unscored: inputs.length - scored.length, sellableOnShopify: sellable.length },
    sellable: {
      sellingPrice: stats(sellable.map((row) => row.sellingPrice)),
      maxCpaJpy: stats(sellable.map((row) => row.maxCpaJpy)),
      breakEvenRoas: stats(sellable.map((row) => row.breakEvenRoas)),
      marginRate: stats(sellable.map((row) => row.marginRate)),
    },
    priceBands,
    topByMaxCpa: [...sellable].sort((a, b) => b.maxCpaJpy - a.maxCpaJpy).slice(0, top).map(pick),
    lowestBreakEvenRoas: [...sellable].sort((a, b) => a.breakEvenRoas - b.breakEvenRoas || b.maxCpaJpy - a.maxCpaJpy).slice(0, top).map(pick),
  };
}
