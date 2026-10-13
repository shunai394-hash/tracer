import test from "node:test";
import assert from "node:assert/strict";
import { dedupeGoogleTrendItems, normalizeGoogleTrendQuery } from "../lib/intelligence/google-trends-dedupe.ts";

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
