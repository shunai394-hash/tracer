import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("public/ai-live-short-drama-studio.html", "utf8");
const route = readFileSync("app/api/admin/ai-live/fish-audio/route.ts", "utf8");
const childDesignRoute = readFileSync("app/api/admin/ai-live/fish-audio/child-voice-design/route.ts", "utf8");
const privateChildVoices = readFileSync("lib/ai-live/fish-audio-private-drama-voices.ts", "utf8");
const voicesRoute = readFileSync("app/api/admin/ai-live/fish-audio/voices/route.ts", "utf8");

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

test("project bundle saves and restores generated audio without server storage", () => {
  assert.ok(page.includes('id="saveProject"'));
  assert.ok(page.includes('id="loadProject"'));
  assert.ok(page.includes('id="projectFile"'));
  assert.ok(page.includes('format="tracer-short-drama-project"') || page.includes('format="tracer-short-drama-project"'));
  assert.ok(page.includes('data.format="tracer-short-drama-project"'));
  assert.ok(page.includes("bytesToBase64"));
  assert.ok(page.includes("base64ToBytes"));
  assert.ok(page.includes("row.audioUrl=URL.createObjectURL(blob)"));
  assert.ok(page.includes("52*1024*1024"));
  assert.ok(page.includes("12*1024*1024"));
  assert.ok(page.includes("speakerIdMap"));
  assert.ok(page.includes("現在の脚本・生成音声を置き換えて作品データを読み込みます"));
});


test("fictional child-role voice is designed from text, saved privately, and never cloned from a child's recording", () => {
  assert.ok(page.includes('id="createChildVoice"'));
  assert.ok(page.includes("/api/admin/ai-live/fish-audio/child-voice-design"));
  assert.ok(page.includes("録音を使わず"));
  assert.ok(childDesignRoute.includes("https://api.fish.audio/v1/voice-design"));
  assert.ok(childDesignRoute.includes('model: "voice-design-1"'));
  assert.ok(childDesignRoute.includes('modelForm.set("texts", referenceText)'));
  assert.ok(childDesignRoute.includes("audio_base64"));
  assert.ok(childDesignRoute.includes('modelForm.set("visibility", "private")'));
  assert.ok(childDesignRoute.includes('"tracer-drama-child"'));
  assert.doesNotMatch(childDesignRoute, /request\.formData\(\)|form\.get\(["']audio["']\)/);
  assert.ok(privateChildVoices.includes('model.visibility !== "private"'));
  assert.ok(privateChildVoices.includes('tags.includes(CHILD_DRAMA_TAG)'));
  assert.ok(route.includes("isPrivateDramaChildVoice(privateChildVoices, referenceId)"));
  assert.ok(voicesRoute.includes('source: "private_voice_design"'));
});
