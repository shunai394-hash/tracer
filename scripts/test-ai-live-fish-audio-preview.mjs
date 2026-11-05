import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("app/api/admin/ai-live/fish-audio/route.ts", "utf8");
const voicesRoute = readFileSync("app/api/admin/ai-live/fish-audio/voices/route.ts", "utf8");
const voiceLibrary = readFileSync("lib/ai-live/fish-audio-public-voices.ts", "utf8");
const page = readFileSync("public/ai-live-fish-audio-preview.html", "utf8");\nconst customVoices = readFileSync("lib/ai-live/fish-audio-consented-custom-voices.ts", "utf8");

test("Fish Audio preview is server-side, authenticated, bounded and one-shot", () => {
  assert.ok(route.includes("authorizedAdminToken(request)"));
  assert.ok(route.includes("requireAutomationAuth(request)"));
  assert.ok(route.includes("process.env.FISH_AUDIO_API_KEY"));
  assert.ok(route.includes("listLicensedJapaneseVoices(apiKey)"));
  assert.ok(route.includes("https://api.fish.audio/v1/tts"));
  assert.ok(route.includes("MAX_TEXT_CHARS = 1200"));
  assert.ok(route.includes("MAX_AUDIO_BYTES = 12 * 1024 * 1024"));
  assert.ok(route.includes("AbortController"));
  assert.ok(route.includes('cache: "no-store"'));
  assert.ok(route.includes("voice_not_in_licensed_japanese_library"));
  assert.doesNotMatch(route, /console\.(?:log|error)/i);
  assert.doesNotMatch(route, /ELEVENLABS_API_KEY/);
});

test("voice catalogue is authenticated and restricts results to licensed public Japanese female voices", () => {
  assert.ok(voicesRoute.includes("authorizedAdminToken(request)"));
  assert.ok(voicesRoute.includes("requireAutomationAuth(request)"));
  assert.ok(voicesRoute.includes("listLicensedJapaneseVoices(apiKey)"));
  assert.ok(voiceLibrary.includes('url.searchParams.set("language", "ja")'));
  assert.ok(voiceLibrary.includes('url.searchParams.set("licensed", "true")'));
  assert.ok(voiceLibrary.includes('visibility !== "public"'));
  assert.ok(voiceLibrary.includes("/(female|woman|women|女性|女声|feminine)/u"));
});

test("Fish Audio preview page requires explicit voice selection and explicit generation", () => {
  assert.ok(page.includes("noindex,nofollow"));
  assert.ok(page.includes("/api/admin/ai-live/fish-audio/voices"));
  assert.ok(page.includes("/api/admin/ai-live/fish-audio"));
  assert.ok(page.includes("referenceId: voice.value"));
  assert.ok(page.includes('addEventListener("submit"'));
  assert.ok(page.includes('addEventListener("click"'));
  assert.doesNotMatch(page, /FISH_AUDIO_API_KEY\s*=/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
});

test("private clone voices are separately registered with confirmed consent and server-side allowlisting", () => {
  for (const id of [
    "08b96e6bbf1d4c978d4bfaa2f6e82179",
    "0839163163a84ce5b9919a1681ce156a",
    "4df0df091e0642c1b124488caa06ce6b",
    "8f99ad75c8184f1db0c21d3a906445a4",
  ]) assert.ok(customVoices.includes(id));
  assert.ok(customVoices.includes('consentStatus: "confirmed"'));
  assert.ok(route.includes("isConsentedCustomJapaneseVoice(referenceId)"));
  assert.ok(voicesRoute.includes("getConsentedCustomJapaneseVoices()"));
  assert.ok(page.includes("本人許可確認済み・TRACERカスタム音声"));
  assert.ok(page.includes("publicLicensedCount"));
});
