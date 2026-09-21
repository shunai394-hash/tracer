export type SelectionSettings = {
  minMarginPct: number | null;
  minForecastUnits30d: number | null;
  maxSellerCount: number | null;
  minForecastProfit: number | null;
  maxWeightKg: number | null;
  allowedCategories: string[];
  excludedCategories: string[];
};

export const EMPTY_SELECTION_SETTINGS: SelectionSettings = {
  minMarginPct: null,
  minForecastUnits30d: null,
  maxSellerCount: null,
  minForecastProfit: null,
  maxWeightKg: null,
  allowedCategories: [],
  excludedCategories: [],
};

export function parseSelectionSettings(row: Record<string, unknown> | null): SelectionSettings {
  if (!row) return { ...EMPTY_SELECTION_SETTINGS };
  const categories = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];

  const numberOrNull = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  return {
    minMarginPct: numberOrNull(row.min_margin_pct),
    minForecastUnits30d: numberOrNull(row.min_forecast_units_30d),
    maxSellerCount: numberOrNull(row.max_seller_count),
    minForecastProfit: numberOrNull(row.min_forecast_profit),
    maxWeightKg: numberOrNull(row.max_weight_kg),
    allowedCategories: categories(row.allowed_categories),
    excludedCategories: categories(row.excluded_categories),
  };
}
