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
