import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  EMPTY_SELECTION_SETTINGS,
  parseSelectionSettings,
  type SelectionSettings,
} from "@/lib/intelligence/selection-config";

export async function getSelectionSettings(): Promise<SelectionSettings> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("selection_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return parseSelectionSettings((data as Record<string, unknown> | null) ?? null);
}

export async function saveSelectionSettings(
  settings: SelectionSettings,
): Promise<SelectionSettings> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("selection_settings")
    .upsert(
      {
        id: "default",
        min_margin_pct: settings.minMarginPct,
        min_forecast_units_30d: settings.minForecastUnits30d,
        max_seller_count: settings.maxSellerCount,
        min_forecast_profit: settings.minForecastProfit,
        max_weight_kg: settings.maxWeightKg,
        allowed_categories: settings.allowedCategories,
        excluded_categories: settings.excludedCategories,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return parseSelectionSettings(data as Record<string, unknown>);
}

export { EMPTY_SELECTION_SETTINGS };
