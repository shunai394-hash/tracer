import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { buildGoogleTrendObservationKey, dedupeGoogleTrendItems, normalizeGoogleTrendQuery } from "../lib/intelligence/google-trends-dedupe.ts";

test("normalizes Unicode, casing, and repeated whitespace consistently", () => {
  assert.equal(normalizeGoogleTrendQuery("  ＢＡＧ   care "), "bag care");
  assert.equal(normalizeGoogleTrendQuery("バッグ　ケア"), "バッグ ケア");
});

test("deduplicates normalized query variants and keeps the first observation", () => {
  const items = [
    { title: "トートバッグ", traffic: 1200, publishedAt: "2026-10-13" },
    { title: " トートバッグ ", traffic: 1500, publishedAt: "2026-10-13" },
    { title: "ＴＯＴＥ BAG", traffic: 100, publishedAt: null },
    { title: "tote bag", traffic: 200, publishedAt: null },
    { title: "美容液", traffic: null, publishedAt: null },
  ];
  const unique = dedupeGoogleTrendItems(items);
  assert.deepEqual(unique, [items[0], items[2], items[4]]);
  assert.equal(items.length, 5, "input must not be mutated");
});

test("empty and whitespace-only titles do not create keys", () => {
  assert.deepEqual(dedupeGoogleTrendItems([
    { title: " ", traffic: null, publishedAt: null },
    { title: "", traffic: null, publishedAt: null },
  ]), []);
});


test("Google Trends parser never uses the image URL as a publication date", async () => {
  const source = await readFile(new URL("../lib/intelligence/collect-google-trends.ts", import.meta.url), "utf8");
  assert.match(source, /const publishedAt = extractTag\(item, "pubDate"\);/);
  assert.doesNotMatch(source, /extractTag\(item, "pubDate"\)\s*\?\?\s*extractTag\(item, "ht:picture"\)/);
});

test("daily database key is stable across normalized query variants and separates UTC dates", () => {
  const first = buildGoogleTrendObservationKey("source-1", " ＢＡＧ  care ", "2026-10-13T00:05:00.000Z");
  const repeated = buildGoogleTrendObservationKey("source-1", "bag care", "2026-10-13T23:59:00.000Z");
  const nextDay = buildGoogleTrendObservationKey("source-1", "bag care", "2026-10-14T00:00:00.000Z");
  const otherSource = buildGoogleTrendObservationKey("source-2", "bag care", "2026-10-13T00:05:00.000Z");
  assert.equal(first, repeated);
  assert.notEqual(first, nextDay);
  assert.notEqual(first, otherSource);
});
