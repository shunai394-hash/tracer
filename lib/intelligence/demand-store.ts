import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  DemandStability,
  DemandTrend,
} from "@/lib/intelligence/analyze-demand";

export type DemandIntelligenceItem = {
  id: string;
  query: string;
  productId: string | null;
  candidateId: string | null;
  volume: number | null;
  volumeUnit: string | null;
  velocity7d: number | null;
  velocity14d: number | null;
  velocity30d: number | null;
  change7d: number | null;
  trend: DemandTrend;
  stability: DemandStability;
  spike: boolean;
  demandScore: number | null;
  demandConfidence: number | null;
  socialMentions: number | null;
  observationCount: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  series: Array<{ observedAt: string; value: number }>;
  evidence: Record<string, unknown>;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asTrend(value: unknown): DemandTrend {
  if (
    value === "rising" ||
    value === "surge" ||
    value === "flat" ||
    value === "falling" ||
    value === "crash" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function asStability(value: unknown): DemandStability {
  if (
    value === "sustained" ||
    value === "growing" ||
    value === "seasonal" ||
    value === "spike" ||
    value === "unstable" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function mapRow(row: Record<string, unknown>): DemandIntelligenceItem {
  const series = Array.isArray(row.series)
    ? row.series
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const point = item as { observedAt?: unknown; value?: unknown };
          const value = asNumber(point.value);
          return typeof point.observedAt === "string" && value !== null
            ? { observedAt: point.observedAt, value }
            : null;
        })
        .filter((item): item is { observedAt: string; value: number } => item !== null)
    : [];

  return {
    id: String(row.id),
    query: String(row.query ?? ""),
    productId: typeof row.product_id === "string" ? row.product_id : null,
    candidateId: typeof row.candidate_id === "string" ? row.candidate_id : null,
    volume: asNumber(row.volume),
    volumeUnit: typeof row.volume_unit === "string" ? row.volume_unit : null,
    velocity7d: asNumber(row.velocity_7d),
    velocity14d: asNumber(row.velocity_14d),
    velocity30d: asNumber(row.velocity_30d),
    change7d: asNumber(row.change_7d),
    trend: asTrend(row.trend),
    stability: asStability(row.stability),
    spike: row.spike === true,
    demandScore: asNumber(row.demand_score),
    demandConfidence: asNumber(row.demand_confidence),
    socialMentions: asNumber(row.social_mentions),
    observationCount: asNumber(row.observation_count),
    firstObservedAt:
      typeof row.first_observed_at === "string" ? row.first_observed_at : null,
    lastObservedAt:
      typeof row.last_observed_at === "string" ? row.last_observed_at : null,
    series,
    evidence:
      row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
        ? (row.evidence as Record<string, unknown>)
        : {},
  };
}

export async function listDemandIntelligence(limit = 80): Promise<DemandIntelligenceItem[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("demand_intelligence")
    .select(
      "id, query, product_id, candidate_id, volume, volume_unit, velocity_7d, velocity_14d, velocity_30d, change_7d, trend, stability, spike, demand_score, demand_confidence, social_mentions, observation_count, first_observed_at, last_observed_at, series, evidence",
    )
    .order("last_observed_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function getDemandIntelligence(
  id: string,
): Promise<DemandIntelligenceItem | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("demand_intelligence")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? mapRow(data as Record<string, unknown>) : null;
}

export async function getDemandIntelligenceByQuery(
  query: string,
): Promise<DemandIntelligenceItem | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("demand_intelligence")
    .select("*")
    .eq("query", query)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? mapRow(data as Record<string, unknown>) : null;
}
