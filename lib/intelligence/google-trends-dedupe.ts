import { createHash } from "node:crypto";

export type GoogleTrendItem = {
  title: string;
  traffic: number | null;
  publishedAt: string | null;
};

export function normalizeGoogleTrendQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ja-JP");
}

export function buildGoogleTrendObservationKey(sourceId: string, query: string, observedAt: string | Date): string {
  const day = new Date(observedAt).toISOString().slice(0, 10);
  const digest = createHash("sha256").update(normalizeGoogleTrendQuery(query), "utf8").digest("hex");
  return `google-trends:${sourceId}:${day}:${digest}`;
}

/** Keep one observation per normalized query in a fetched feed. The DB key protects repeated/concurrent runs. */
export function dedupeGoogleTrendItems<T extends GoogleTrendItem>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = normalizeGoogleTrendQuery(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}


export type GoogleTrendObservationRow = {
  idempotency_key: string;
  product_id: null;
  source_id: string;
  signal_type: "search_volume";
  value: number | null;
  unit: "searches_approx";
  observed_at: string;
  metadata: {
    query: string;
    original_query: string;
    country: "JP";
    provider: "google_trends";
    source_url: string;
    published_at: string | null;
  };
};

type UpsertResult = { data: Array<{ id: string }> | null; error: { message: string } | null };

export async function persistGoogleTrendObservations(args: {
  sourceId: string;
  trends: GoogleTrendItem[];
  observedAt: string;
  sourceUrl: string;
  upsert: (
    rows: GoogleTrendObservationRow[],
    options: { onConflict: "idempotency_key"; ignoreDuplicates: true },
  ) => Promise<UpsertResult>;
}) {
  const rows: GoogleTrendObservationRow[] = args.trends.map((trend) => ({
    idempotency_key: buildGoogleTrendObservationKey(args.sourceId, trend.title, args.observedAt),
    product_id: null,
    source_id: args.sourceId,
    signal_type: "search_volume",
    value: trend.traffic,
    unit: "searches_approx",
    observed_at: args.observedAt,
    metadata: {
      query: trend.title,
      original_query: trend.title,
      country: "JP",
      provider: "google_trends",
      source_url: args.sourceUrl,
      published_at: trend.publishedAt,
    },
  }));

  const { data, error } = await args.upsert(rows, {
    onConflict: "idempotency_key",
    ignoreDuplicates: true,
  });
  if (error) throw new Error(`Failed to insert Google Trends observations: ${error.message}`);
  const inserted = data?.length ?? 0;
  return { rows, inserted, alreadyObserved: rows.length - inserted };
}
