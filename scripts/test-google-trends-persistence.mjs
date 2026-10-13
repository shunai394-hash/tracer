import test from "node:test";
import assert from "node:assert/strict";
import { persistGoogleTrendObservations } from "../lib/intelligence/google-trends-dedupe.ts";

const trends = [
  { title: " トートバッグ ", traffic: 1200, publishedAt: "Tue, 13 Oct 2026 10:00:00 GMT" },
  { title: "美容液", traffic: null, publishedAt: null },
];

test("collector persistence builds correctly keyed rows and sends one idempotent batch", async () => {
  let callCount = 0;
  const result = await persistGoogleTrendObservations({
    sourceId: "source-123",
    trends,
    observedAt: "2026-10-13T12:00:00.000Z",
    sourceUrl: "https://trends.google.com/trending/rss?geo=JP",
    upsert: async (rows, options) => {
      callCount += 1;
      assert.equal(rows.length, 2);
      assert.deepEqual(options, { onConflict: "idempotency_key", ignoreDuplicates: true });
      assert.equal(rows[0].source_id, "source-123");
      assert.equal(rows[0].signal_type, "search_volume");
      assert.equal(rows[0].value, 1200);
      assert.equal(rows[0].metadata.query, " トートバッグ ");
      assert.equal(rows[0].metadata.country, "JP");
      assert.equal(rows[0].metadata.published_at, trends[0].publishedAt);
      assert.match(rows[0].idempotency_key, /^google-trends:source-123:2026-10-13:/);
      assert.equal(rows[1].value, null);
      assert.equal(rows[1].metadata.published_at, null);
      return { data: [{ id: "inserted-1" }], error: null };
    },
  });

  assert.equal(callCount, 1, "the feed must be persisted in one batch");
  assert.equal(result.inserted, 1);
  assert.equal(result.alreadyObserved, 1);
  assert.equal(result.rows.length, 2);
});

test("persistence surfaces database errors instead of reporting success", async () => {
  await assert.rejects(
    persistGoogleTrendObservations({
      sourceId: "source-123",
      trends: [trends[0]],
      observedAt: "2026-10-13T12:00:00.000Z",
      sourceUrl: "https://trends.google.com/trending/rss?geo=JP",
      upsert: async () => ({ data: null, error: { message: "database unavailable" } }),
    }),
    /Failed to insert Google Trends observations: database unavailable/,
  );
});

test("zero inserted rows are reported as already observed, not new inserts", async () => {
  const result = await persistGoogleTrendObservations({
    sourceId: "source-123",
    trends: [trends[0]],
    observedAt: "2026-10-13T12:00:00.000Z",
    sourceUrl: "https://trends.google.com/trending/rss?geo=JP",
    upsert: async () => ({ data: [], error: null }),
  });
  assert.equal(result.inserted, 0);
  assert.equal(result.alreadyObserved, 1);
});
