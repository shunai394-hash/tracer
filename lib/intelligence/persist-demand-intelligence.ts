import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { analyzeDemandSeries } from "@/lib/intelligence/analyze-demand";

type ObservationRow = {
  id: string;
  product_id: string | null;
  value: number | string | null;
  unit: string | null;
  signal_type: string;
  observed_at: string;
  metadata: Record<string, unknown> | null;
};

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function queryOf(row: ObservationRow): string | null {
  const metadata = asRecord(row.metadata);
  const query = typeof metadata.query === "string" ? metadata.query : null;
  if (!query) return null;
  const normalized = normalizeQuery(query);
  return normalized || null;
}

export async function persistDemandIntelligence(): Promise<{
  processedQueries: number;
  upserted: number;
  skipped: number;
}> {
  const supabase = createSupabaseAdminClient();
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();

  const [observationsResult, matchesResult, candidatesResult] = await Promise.all([
    supabase
      .from("demand_observations")
      .select("id, product_id, value, unit, signal_type, observed_at, metadata")
      .gte("observed_at", since)
      .order("observed_at", { ascending: true }),
    supabase.from("demand_product_matches").select("demand_observation_id, product_id"),
    supabase
      .from("demand_product_candidates")
      .select("id, query, demand_observation_id"),
  ]);

  if (observationsResult.error) throw new Error(observationsResult.error.message);
  if (matchesResult.error) throw new Error(matchesResult.error.message);
  if (candidatesResult.error) throw new Error(candidatesResult.error.message);

  const observations = (observationsResult.data ?? []) as ObservationRow[];
  const productByObservation = new Map(
    (matchesResult.data ?? []).map((row) => [
      row.demand_observation_id as string,
      row.product_id as string,
    ]),
  );
  const candidateByQuery = new Map(
    (candidatesResult.data ?? []).map((row) => [
      normalizeQuery(String(row.query ?? "")),
      row,
    ]),
  );

  const grouped = new Map<string, ObservationRow[]>();
  for (const row of observations) {
    const query = queryOf(row);
    if (!query) continue;
    const list = grouped.get(query) ?? [];
    list.push(row);
    grouped.set(query, list);
  }

  let upserted = 0;
  let skipped = 0;

  for (const [query, rows] of grouped) {
    const searchRows = rows.filter((row) => row.signal_type === "search_volume");
    const socialRows = rows.filter((row) => row.signal_type === "social_mentions");
    const points = searchRows
      .map((row) => ({
        value: asNumber(row.value),
        observedAt: row.observed_at,
      }))
      .filter((row): row is { value: number; observedAt: string } => row.value !== null);

    if (points.length === 0) {
      skipped += 1;
      continue;
    }

    const latestSearch = searchRows[searchRows.length - 1] ?? null;
    const latestSocial = socialRows[socialRows.length - 1] ?? null;
    const analysis = analyzeDemandSeries({
      points,
      socialMentions: asNumber(latestSocial?.value),
      volumeUnit: latestSearch?.unit ?? "searches_approx",
    });

    const matchedProduct =
      [...searchRows]
        .reverse()
        .map((row) => row.product_id ?? productByObservation.get(row.id) ?? null)
        .find((value) => value) ?? null;
    const candidate = candidateByQuery.get(query) ?? null;
    const window7 = analysis.windows.find((item) => item.days === 7);
    const window14 = analysis.windows.find((item) => item.days === 14);
    const window30 = analysis.windows.find((item) => item.days === 30);

    const result = await supabase.from("demand_intelligence").upsert(
      {
        query,
        latest_observation_id: latestSearch?.id ?? null,
        product_id: matchedProduct,
        candidate_id: candidate?.id ?? null,
        volume: analysis.volume,
        volume_unit: analysis.volumeUnit,
        velocity_7d: window7?.pct ?? null,
        velocity_14d: window14?.pct ?? null,
        velocity_30d: window30?.pct ?? null,
        change_7d: window7?.change ?? null,
        change_14d: window14?.change ?? null,
        change_30d: window30?.change ?? null,
        trend: analysis.trend,
        stability: analysis.stability,
        spike: analysis.spike,
        demand_score: analysis.demandScore,
        demand_confidence: analysis.demandConfidence,
        social_mentions: analysis.socialMentions,
        observation_count: analysis.observationCount,
        first_observed_at: analysis.firstObservedAt,
        last_observed_at: analysis.lastObservedAt,
        series: analysis.series,
        evidence: analysis.evidence,
        metadata: {
          latest_observation_id: latestSearch?.id ?? null,
          source: "demand_observations",
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "query" },
    );

    if (result.error) {
      throw new Error(
        `Failed to upsert demand intelligence for "${query}": ${result.error.message}`,
      );
    }

    upserted += 1;
  }

  return {
    processedQueries: grouped.size,
    upserted,
    skipped,
  };
}
