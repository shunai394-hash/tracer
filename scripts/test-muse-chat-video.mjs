import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isMuseVideoRequest, planMuseVideoRequest } from "../lib/muse/video-request.ts";

const chatRoute = await readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
const statusRoute = await readFile(new URL("../app/api/chat/muse-video/route.ts", import.meta.url), "utf8");
const queue = await readFile(new URL("../lib/muse/render-queue.ts", import.meta.url), "utf8");
const chatUi = await readFile(new URL("../components/tracer-chat.tsx", import.meta.url), "utf8");

assert.equal(isMuseVideoRequest("今おすすめの商品は？"), false);
assert.equal(isMuseVideoRequest("30秒の商品紹介動画を作って"), true);
assert.equal(isMuseVideoRequest("この台本で動画を作って"), true);
assert.equal(isMuseVideoRequest("この人物に音声を合わせて口パクさせて"), true);
assert.equal(isMuseVideoRequest("BGMと字幕を付けてドラマにして"), true);
assert.equal(isMuseVideoRequest("この画像を使って動画を作って"), true);

const incomplete = planMuseVideoRequest("30秒の商品紹介動画を作って");
assert.equal(incomplete.ready, false);
assert.ok(incomplete.missing.includes("商品名"));
assert.ok(incomplete.missing.includes("紹介する要点"));
assert.equal(incomplete.manifest, null);

const product = planMuseVideoRequest("30秒の商品紹介動画を作って。商品名：トレーサーマグカップ。紹介：軽くて毎日使える保温マグです。");
assert.equal(product.ready, true);
assert.equal(product.manifest.format, "muse-motion-manifest");
assert.equal(product.manifest.version, 1);
assert.equal(product.manifest.aspect, "16:9");
const durations = product.manifest.scenes.map((scene) => scene.durationSeconds);
const total = durations.reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(total - 30) < 0.2, `expected about 30 seconds, got ${total}`);
assert.ok(product.manifest.scenes.every((scene) => scene.text && scene.motionPreset));
assert.ok(product.question.includes("まだ完成ではありません") || product.question.includes("完成するまで"));

const lipsync = planMuseVideoRequest("この人物に音声を合わせて口パクさせて", {});
assert.equal(lipsync.ready, false);
assert.ok(lipsync.missing.some((item) => item.includes("画像") || item.includes("口パク")));

const withAssets = planMuseVideoRequest("この人物に音声を合わせて口パクさせて。台本：「こんにちは、新作です。」", {
  lipsync: true,
  voice: true,
});
assert.equal(withAssets.ready, true);
assert.equal(withAssets.manifest.lipsyncFile, "lipsync");

assert.ok(chatRoute.includes('requestedBy: "muse-chat"'));
assert.ok(chatRoute.includes("enqueueMuseRenderJob"));
assert.ok(chatRoute.includes('status: "queued"'));
assert.ok(!chatRoute.includes("status: \"succeeded\""));
assert.ok(statusRoute.includes('finished ? "完成"'));
assert.ok(statusRoute.includes("outputVideoUrl: finished ? job.outputVideoUrl : null"));
assert.ok(queue.includes("ai_live_muse_render_jobs"));
assert.ok(chatUi.includes("/api/chat/muse-video?id="));
assert.ok(chatUi.includes('download="tracer-muse.mp4"'));
assert.ok(chatUi.includes('message.museVideo.status === "succeeded" && message.museVideo.outputVideoUrl'));

console.log("Muse chat video request: PASS");
