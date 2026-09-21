export type StockObservation = {
  inventory: number | null;
  availability: string | null;
};

export type StockoutGapResult = {
  observedCount: number;
  stockoutCount: number | null;
  stockoutRate: number | null;
  supplyGap: boolean | null;
  score: number | null;
  confidence: number;
  evidence: Record<string, unknown>;
};

function isStockout(row: StockObservation): boolean | null {
  if (typeof row.inventory === "number") return row.inventory <= 0;
  if (!row.availability) return null;
  const normalized = row.availability.toLowerCase();
  if (/(out of stock|sold out|unavailable)/.test(normalized)) return true;
  if (/(in stock|available|on sale)/.test(normalized)) return false;
  return null;
}

export function evaluateStockoutGap(args: {
  demandRising: boolean | null;
  stocks: StockObservation[];
}): StockoutGapResult {
  const known = args.stocks
    .map((row) => isStockout(row))
    .filter((value): value is boolean => value !== null);

  if (known.length === 0) {
    return {
      observedCount: args.stocks.length,
      stockoutCount: null,
      stockoutRate: null,
      supplyGap: null,
      score: null,
      confidence: 0,
      evidence: { note: "inventory_not_observed" },
    };
  }

  const stockoutCount = known.filter(Boolean).length;
  const stockoutRate = stockoutCount / known.length;
  const supplyGap = args.demandRising === true && stockoutRate >= 0.4;

  return {
    observedCount: known.length,
    stockoutCount,
    stockoutRate: Number(stockoutRate.toFixed(4)),
    supplyGap,
    score: Number((Math.max(0, Math.min(100, stockoutRate * 100))).toFixed(4)),
    confidence: 0.6,
    evidence: {
      demand_rising: args.demandRising,
      known_stock_rows: known.length,
    },
  };
}

export function verifyStockoutGapInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const missing = evaluateStockoutGap({
    demandRising: true,
    stocks: [{ inventory: null, availability: null }],
  });
  const gap = evaluateStockoutGap({
    demandRising: true,
    stocks: [
      { inventory: 0, availability: "out of stock" },
      { inventory: 0, availability: null },
      { inventory: 4, availability: "in stock" },
    ],
  });

  const cases = [
    {
      name: "missing_stock_is_not_a_gap",
      expected: true,
      actual: missing.supplyGap === null && missing.stockoutRate === null,
    },
    {
      name: "rising_demand_plus_stockouts_is_gap",
      expected: true,
      actual: gap.supplyGap === true && gap.stockoutCount === 2,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
