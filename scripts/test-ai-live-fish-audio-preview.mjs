import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("app/api/admin/ai-live/fish-audio/route.ts", "utf8");
const page = readFileSync("public/ai-live-fish-audio-preview.html", "utf8");

test("Fish Audio preview is server-side, authenticated, bounded and one-shot", () => {
  assert.match(route, /authorizedAdminToken\(request\)/);
  assert.match(route, /requireAutomationAuth\(request\)/);
  assert.match(route, /process\.env\.FISH_AUDIO_API_KEY/);
  assert.match(route, /process\.env\.FISH_AUDIO_REFERENCE_ID/);
  assert.match(route, /https:\/\/api\.fish\.audio\/v1\/tts/);
  assert.match(route, /MAX_TEXT_CHARS = 1200/);
  assert.match(route, /MAX_AUDIO_BYTES = 12 \* 1024 \* 1024/);
  assert.match(route, /AbortController/);
  assert.match(route, /cache: "no-store"/);
  assert.doesNotMatch(route, /retry|console\.log|console\.error/i);
  assert.doesNotMatch(route, /ELEVENLABS_API_KEY/);
});

test("Fish Audio preview page never exposes provider credentials or triggers generation automatically", () => {
  assert.match(page, /noindex,nofollow/);
  assert.match(page, /\/api\/admin\/ai-live\/fish-audio/);
  assert.match(page, /Authorization/);
  assert.doesNotMatch(page, /FISH_AUDIO_API_KEY\s*=/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(page, /addEventListener\("submit"/);
});
