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


const COMMERCE_DEMAND_TERMS = [
  "イヤホン", "ヘッドホン", "earbuds", "earphone", "headphones", "airpods",
  "スマホ", "スマートフォン", "iphone", "ipad", "galaxy", "pixel",
  "美容", "化粧", "スキンケア", "美容液", "クリーム", "日焼け止め",
  "serum", "moisturizer", "sunscreen", "shoes", "sneakers", "スニーカー",
  "靴", "バッグ", "財布", "服", "シャツ", "ドレス", "ワンピース",
  "アクセサリー", "ジュエリー", "家電", "掃除", "収納", "キッチン",
  "水筒", "ボトル", "タンブラー", "寝具", "枕", "マットレス",
  "フィットネス", "筋トレ", "ヨガ", "ペット", "猫", "犬", "car", "車用品",
  "収納", "便利グッズ", "ランキング", "おすすめ", "比較", "レビュー",
];

const NON_COMMERCE_DEMAND_TERMS = [
  "俳優", "女優", "芸能", "ニュース", "速報", "映画", "ドラマ", "ネタバレ",
  "選挙", "政治", "政党", "首相", "国会", "ミサイル", "事件", "逮捕", "勾留",
  "競馬", "jra", "サッカー", "野球", "卓球", "ゴルフ", "大会", "リーグ",
  "人物", "天気", "地震", "台風", "地名", "駅", "路線", "学校",
];

function isCommerceDemandQuery(query: string, matchedProduct: string | null, candidateQuery: string | null): boolean {
  if (matchedProduct || candidateQuery) return true;
  const normalized = normalizeQuery(query).toLowerCase();
  if (!normalized || /[�]/.test(normalized)) return false;
  if (NON_COMMERCE_DEMAND_TERMS.some((term) => normalized.includes(term))) return false;
  return COMMERCE_DEMAND_TERMS.some((term) => normalized.includes(term));
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
    const searchRows = rows.filter((row) => (row.signal_type === "search_volume" || row.signal_type === "search_result_count"));
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
    const candidateQuery = typeof candidate?.query === "string" ? normalizeQuery(candidate.query) : null;
    if (!isCommerceDemandQuery(query, matchedProduct, candidateQuery)) {
      skipped += 1;
      continue;
    }
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
