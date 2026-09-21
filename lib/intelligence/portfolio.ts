export type PortfolioItem = {
  id: string;
  productName: string;
  category: string | null;
  estimatedCost: number | null;
  forecastProfit30d: number | null;
  forecastUnits30d: number | null;
  selectionEligible: boolean;
};

export type PortfolioResult = {
  attempted: boolean;
  items: PortfolioItem[];
  totalCost: number | null;
  totalForecastProfit: number | null;
  note: string;
};

export function optimizePortfolio(args: {
  budget: number | null;
  items: PortfolioItem[];
}): PortfolioResult {
  const usable = args.items.filter(
    (item) =>
      item.selectionEligible &&
      item.estimatedCost !== null &&
      item.forecastProfit30d !== null,
  );

  if (args.budget === null || usable.length < 2) {
    return {
      attempted: false,
      items: [],
      totalCost: null,
      totalForecastProfit: null,
      note:
        args.budget === null
          ? "budget_unknown"
          : "insufficient_priced_forecasts_for_portfolio",
    };
  }

  const ranked = [...usable].sort(
    (a, b) => (b.forecastProfit30d ?? 0) - (a.forecastProfit30d ?? 0),
  );
  const selected: PortfolioItem[] = [];
  let spent = 0;
  const categories = new Set<string>();

  for (const item of ranked) {
    const cost = item.estimatedCost ?? 0;
    if (spent + cost > args.budget) continue;
    selected.push(item);
    spent += cost;
    if (item.category) categories.add(item.category);
  }

  const profit = selected.reduce(
    (sum, item) => sum + (item.forecastProfit30d ?? 0),
    0,
  );

  return {
    attempted: selected.length > 0,
    items: selected,
    totalCost: selected.length > 0 ? spent : null,
    totalForecastProfit: selected.length > 0 ? profit : null,
    note: `greedy_by_forecast_profit_categories_${categories.size}`,
  };
}

export function verifyPortfolioInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const skipped = optimizePortfolio({
    budget: null,
    items: [
      {
        id: "a",
        productName: "A",
        category: "auto",
        estimatedCost: 10,
        forecastProfit30d: 20,
        forecastUnits30d: 5,
        selectionEligible: true,
      },
    ],
  });

  const cases = [
    {
      name: "no_budget_skips_portfolio",
      expected: true,
      actual: skipped.attempted === false && skipped.items.length === 0,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
