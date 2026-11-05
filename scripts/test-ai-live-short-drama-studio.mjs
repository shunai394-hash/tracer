import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("public/ai-live-short-drama-studio.html", "utf8");
const route = readFileSync("app/api/admin/ai-live/fish-audio/route.ts", "utf8");

test("short drama studio assigns voices per character and lines", () => {
  assert.ok(page.includes("担当ボイス"));
  assert.ok(page.includes("セリフ本文"));
  assert.ok(page.includes("speakerId"));
  assert.ok(page.includes("emotion"));
  assert.ok(page.includes("pace"));
  assert.ok(page.includes("pause"));
  assert.ok(page.includes("buildSpokenText"));
});

test("generation is explicit, sequential, bounded, and stoppable", () => {
  assert.ok(page.includes('addEventListener("click",async()=>{const valid=lineRows.filter'));
  assert.ok(page.includes("confirm(valid.length+"));
  assert.ok(page.includes("await generateLine(row,el,true)"));
  assert.ok(page.includes("stopRequested"));
  assert.ok(page.includes('fetch("/api/admin/ai-live/fish-audio"'));
  assert.ok(page.includes('"Authorization":"Bearer "+token.value.trim()'));
  assert.ok(route.includes("MAX_TEXT_CHARS = 1200"));
  assert.ok(route.includes("MAX_AUDIO_BYTES = 12 * 1024 * 1024"));
  assert.ok(route.includes("PROVIDER_TIMEOUT_MS = 25_000"));
});

test("studio does not auto-publish, schedule, or retry generated audio", () => {
  assert.ok(page.includes("自動生成・自動再試行・SNS投稿は行いません"));
  assert.ok(page.includes("MP3保存"));
  assert.ok(page.includes("脚本JSONを書き出す"));
  assert.doesNotMatch(page, /setInterval\(|setTimeout\(/);
  assert.doesNotMatch(page, /\/api\/.*publish|social\/post/i);
});

test("studio provides a separate multi-file BGM library with preview controls", () => {
  assert.ok(page.includes('id="bgmPanel"'));
  assert.ok(page.includes('id="bgmFiles"'));
  assert.ok(page.includes('multiple'));
  assert.ok(page.includes("async function uploadBgmFiles"));
  assert.ok(page.includes('fetch("/api/admin/ai-live/short-drama/bgm"'));
  assert.ok(page.includes('id="bgmVolume"'));
  assert.ok(page.includes('id="bgmLoop"'));
  assert.ok(page.includes('id="bgmPreview"'));
  assert.ok(page.includes("MP3音源"));
  assert.ok(page.includes("台詞音声には自動で合成"));
});

test("BGM API is admin-protected, private-storage based, and MP3-size bounded", () => {
  const bgmRoute = readFileSync("app/api/admin/ai-live/short-drama/bgm/route.ts", "utf8");
  assert.ok(bgmRoute.includes('const BUCKET = "tracer-drama-bgm"'));
  assert.ok(bgmRoute.includes("MAX_FILE_BYTES = 10 * 1024 * 1024"));
  assert.ok(bgmRoute.includes("await authorize(request)"));
  assert.ok(bgmRoute.includes('contentType: "audio/mpeg"'));
  assert.ok(bgmRoute.includes("metadata: { genre:"));
  assert.ok(bgmRoute.includes("createSignedUrl"));
});
