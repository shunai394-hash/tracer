import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("app/api/admin/ai-live/fish-audio/route.ts", "utf8");
const page = readFileSync("public/ai-live-fish-audio-preview.html", "utf8");

test("Fish Audio preview is server-side, authenticated, bounded and one-shot", () => {
  assert.ok(route.includes("authorizedAdminToken(request)"));
  assert.ok(route.includes("requireAutomationAuth(request)"));
  assert.ok(route.includes("process.env.FISH_AUDIO_API_KEY"));
  assert.ok(route.includes("process.env.FISH_AUDIO_REFERENCE_ID"));
  assert.ok(route.includes("https://api.fish.audio/v1/tts"));
  assert.ok(route.includes("MAX_TEXT_CHARS = 1200"));
  assert.ok(route.includes("MAX_AUDIO_BYTES = 12 * 1024 * 1024"));
  assert.ok(route.includes("AbortController"));
  assert.ok(route.includes('cache: "no-store"'));
  assert.doesNotMatch(route, /console\.(?:log|error)/i);
  assert.doesNotMatch(route, /ELEVENLABS_API_KEY/);
});

test("Fish Audio preview page never exposes provider credentials or triggers generation automatically", () => {
  assert.ok(page.includes("noindex,nofollow"));
  assert.ok(page.includes("/api/admin/ai-live/fish-audio/"));
  assert.ok(page.includes("Authorization"));
  assert.doesNotMatch(page, /FISH_AUDIO_API_KEY\s*=/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.ok(page.includes('addEventListener("submit"'));
});
