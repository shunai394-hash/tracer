import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allowViewerComment,
  buildProductScript,
  isIntroducibleProduct,
  nextIntroducibleIndex,
  productImageForDisplay,
  speechMixVolume,
  tiktokReadiness,
  youtubeReadiness,
} from "../lib/ai-live/program.ts";

const product = {
  id: "bag-1",
  title: "レザー調 レディースハンドバッグ",
  description: "肩から掛けられる大きめのバッグです。",
  sellingPrice: 12800,
  currency: "JPY",
  inStock: true,
  productUrl: "https://tracer.base.ec/items/bag-1",
  imageUrl: "https://cdn.example.com/bag-black.jpg",
};
const other = { ...product, id: "bag-2", title: "メッシュハンドバッグ", imageUrl: "https://cdn.example.com/bag-white.jpg" };

assert.equal(isIntroducibleProduct({ ...product, inStock: false }), false);
assert.equal(isIntroducibleProduct({ ...product, sellingPrice: 0 }), false);
assert.equal(isIntroducibleProduct({ ...product, productUrl: "http://tracer.base.ec/items/bag-1" }), false);
assert.equal(nextIntroducibleIndex([{ ...product, inStock: false }, product], 0), 1);

const first = buildProductScript(product, 0);
const second = buildProductScript(product, 1);
assert.notEqual(first, second);
assert.match(first, /12,800円/);
assert.match(first, /レザー調 レディースハンドバッグ/);
assert.doesNotMatch(first, /送料無料|割引|治る|残り\d+/);
assert.throws(() => buildProductScript({ ...product, description: null, title: "" }, 0));

assert.equal(productImageForDisplay(product), "https://cdn.example.com/bag-black.jpg");
assert.equal(productImageForDisplay({ ...product, imageUrl: null }), null);
assert.notEqual(productImageForDisplay(other), productImageForDisplay(product));
assert.equal(productImageForDisplay({ ...other, imageUrl: "http://cdn.example.com/wrong.jpg" }), null);

assert.equal(speechMixVolume(0.35, "bed", 0), 0.35);
assert.ok(Math.abs(speechMixVolume(0.35, "duck", 400) - 0.35 * 0.18) < 1e-9);
assert.ok(speechMixVolume(0.35, "duck", 0) === 0.35);
assert.ok(speechMixVolume(0.35, "restore", 400) === 0.35);
assert.ok(speechMixVolume(0.35, "duck", 200) < 0.35);
assert.ok(speechMixVolume(0.35, "duck", 200) > 0.35 * 0.18);
assert.ok(speechMixVolume(2, "bed", 0) <= 1);

const recent = [
  { authorKey: "a", text: "こんにちは", atMs: 1000 },
  { authorKey: "a", text: "こんにちは", atMs: 1100 },
  { authorKey: "a", text: "こんにちは", atMs: 1200 },
  { authorKey: "a", text: "こんにちは", atMs: 1300 },
];
assert.equal(allowViewerComment({ text: "価格は？", authorKey: "a", nowMs: 1400, recent }).allow, false);
assert.equal(allowViewerComment({ text: "価格は？", authorKey: "b", nowMs: 1400, recent: [] }).allow, true);

const youtube = youtubeReadiness({ clientId: false, clientSecret: true, refreshToken: false });
assert.equal(youtube.canStart, false);
assert.deepEqual(youtube.missing, ["YOUTUBE_CLIENT_ID", "YOUTUBE_REFRESH_TOKEN"]);
const tiktok = tiktokReadiness(false);
assert.equal(tiktok.canStart, false);
assert.match(tiktok.steps.join("\n"), /livecenter\.tiktok\.com\/producer/);
assert.match(tiktok.steps.join("\n"), /非公式ログイン/);

const route = readFileSync(new URL("../app/api/admin/ai-live/session/route.ts", import.meta.url), "utf8");
const products = readFileSync(new URL("../lib/ai-live/sellable-products.ts", import.meta.url), "utf8");
const runner = readFileSync(new URL("../worker/ai-live-runner.mjs", import.meta.url), "utf8");
assert.match(route, /live: false/);
assert.doesNotMatch(route, /rtmp:\/\//i);
assert.match(products, /\.eq\("published", true\)/);
assert.match(products, /\.eq\("orderable", true\)/);
assert.match(products, /\.gt\("inventory", 0\)/);
assert.doesNotMatch(products, /supplier_variant_id|expected_profit|shipping_cost/);
assert.match(runner, /live: false/);
assert.doesNotMatch(runner, /console\.log\(process\.env/);

const obs = readFileSync(new URL("../public/ai-live-obs.html", import.meta.url), "utf8");
assert.match(obs, /id="productShot"/);
assert.match(obs, /id="autoLiveStart"/);
assert.match(obs, /data-layout/);
assert.match(obs, /ducked\?baseVolume\*\.18:baseVolume/);
assert.match(obs, /TikTokコメントと配信先は未接続/);
assert.match(obs, /speechMixVolume/);

console.log("AI live program contract checks passed");
