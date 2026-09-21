export type OrderMode = "MANUAL" | "APPROVAL" | "AUTO";

export type OrderState =
  | "AUTO_CANDIDATE"
  | "NEEDS_APPROVAL"
  | "AUTO_FORBIDDEN"
  | "ORDER_FORBIDDEN"
  | "UNKNOWN_BLOCKED";

export type ConfidenceBand = "high" | "medium" | "low" | "unknown";

export type OrderingSettings = {
  mode: OrderMode;
  dailyOrderLimit: number | null;
  perProductOrderLimit: number | null;
  monthlyOrderBudget: number | null;
  categoryBudgets: Record<string, number>;
  defaultLeadTimeDays: number | null;
  defaultSafetyStock: number | null;
};

export const DEFAULT_ORDERING_SETTINGS: OrderingSettings = {
  mode: "APPROVAL",
  dailyOrderLimit: null,
  perProductOrderLimit: null,
  monthlyOrderBudget: null,
  categoryBudgets: {},
  defaultLeadTimeDays: null,
  defaultSafetyStock: null,
};

export function parseOrderingSettings(
  row: Record<string, unknown> | null,
): OrderingSettings {
  if (!row) return { ...DEFAULT_ORDERING_SETTINGS };

  const numberOrNull = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const mode =
    row.mode === "MANUAL" || row.mode === "APPROVAL" || row.mode === "AUTO"
      ? row.mode
      : "APPROVAL";

  const categoryBudgets =
    row.category_budgets &&
    typeof row.category_budgets === "object" &&
    !Array.isArray(row.category_budgets)
      ? Object.fromEntries(
          Object.entries(row.category_budgets as Record<string, unknown>)
            .map(([key, value]) => [key, numberOrNull(value)])
            .filter((entry): entry is [string, number] => entry[1] !== null),
        )
      : {};

  return {
    mode,
    dailyOrderLimit: numberOrNull(row.daily_order_limit),
    perProductOrderLimit: numberOrNull(row.per_product_order_limit),
    monthlyOrderBudget: numberOrNull(row.monthly_order_budget),
    categoryBudgets,
    defaultLeadTimeDays: numberOrNull(row.default_lead_time_days),
    defaultSafetyStock: numberOrNull(row.default_safety_stock),
  };
}

export function confidenceBand(confidence: number | null): ConfidenceBand {
  if (confidence === null || !Number.isFinite(confidence)) return "unknown";
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.4) return "medium";
  if (confidence > 0) return "low";
  return "unknown";
}
