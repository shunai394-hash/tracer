export type GoogleTrendItem = {
  title: string;
  traffic: number | null;
  publishedAt: string | null;
};

export function normalizeGoogleTrendQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ja-JP");
}

/**
 * Keep one observation per normalized query in a single fetched feed.
 * The first feed item wins so duplicate entries cannot inflate the batch.
 * This is intentionally in-memory only; cross-run idempotency needs a
 * database-backed key and is not claimed by this helper.
 */
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
