import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";

const page = readFileSync("public/ai-live-short-drama-studio.html", "utf8");
const route = readFileSync("app/api/admin/ai-live/fish-audio/route.ts", "utf8");
const childDesignRoute = readFileSync("app/api/admin/ai-live/fish-audio/child-voice-design/route.ts", "utf8");
const cloneRoute = readFileSync("app/api/admin/ai-live/fish-audio/clone/route.ts", "utf8");
const diagnosticsRoute = readFileSync("app/api/admin/ai-live/fish-audio/diagnostics/route.ts", "utf8");
const privateCloneVoices = readFileSync("lib/ai-live/fish-audio-private-drama-clone-voices.ts", "utf8");
const privateChildVoices = readFileSync("lib/ai-live/fish-audio-private-drama-voices.ts", "utf8");
const voicesRoute = readFileSync("app/api/admin/ai-live/fish-audio/voices/route.ts", "utf8");
const publicVoiceLibrary = readFileSync("lib/ai-live/fish-audio-public-voices.ts", "utf8");
const bgmRoute = readFileSync("app/api/admin/ai-live/short-drama/bgm/route.ts", "utf8");

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


test("voice picker includes the full paginated public catalogue and all added private voices in one selector", () => {
  assert.ok(publicVoiceLibrary.includes("MAX_PUBLIC_MODELS = 1000"));
  assert.ok(publicVoiceLibrary.includes("PAGE_SIZE = 100"));
  assert.ok(publicVoiceLibrary.includes("fetchLicensedPage(apiKey, page)"));
  assert.ok(publicVoiceLibrary.includes("firstPage.total"));
  assert.ok(voicesRoute.includes("...publicVoices.map"));
  assert.ok(voicesRoute.includes("...customVoices"));
  assert.ok(voicesRoute.includes("...privateChildVoices.map"));
  assert.ok(page.includes("Fish Audio 公開日本語ボイス"));
  assert.ok(page.includes("追加クローン音声（許可確認済み）"));
  assert.ok(page.includes("追加の架空キャラクターボイス"));
  assert.ok(page.includes("function optionList(selected"));
});

test("public and private voice catalogues load concurrently without blocking the public list", () => {
  assert.ok(voicesRoute.includes("Promise.allSettled(["));
  assert.ok(voicesRoute.includes("listLicensedJapaneseVoices(apiKey)"));
  assert.ok(voicesRoute.includes("listPrivateDramaChildVoices(apiKey)"));
  assert.ok(voicesRoute.includes('publicResult.status === "fulfilled"'));
  assert.ok(voicesRoute.includes('privateChildResult.status === "fulfilled"'));
});

test("voice choices load automatically after the admin token is entered", () => {
  assert.ok(page.includes('token.addEventListener("change",loadVoices)'));
  assert.ok(page.includes('token.addEventListener("keydown"'));
  assert.ok(page.includes('function loadVoices()'));
  assert.ok(page.includes('refreshCharacterVoiceOptions()'));
  assert.ok(page.includes('日本語ボイス "+voices.length+"件を読み込みました'));
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



test("adult consented voice clones are registered privately and rediscovered in the drama studio", () => {
  assert.ok(page.includes('id="cloneAudio"'));
  assert.ok(page.includes('id="cloneRights"'));
  assert.ok(page.includes('id="registerClone"'));
  assert.ok(page.includes('/api/admin/ai-live/fish-audio/clone'));
  assert.ok(page.includes('form.set("visibility","private")'));
  assert.ok(cloneRoute.includes('speakerType === "child"'));
  assert.ok(cloneRoute.includes('!rightsConfirmed'));
  assert.ok(cloneRoute.includes('payload.set("visibility", "private")'));
  assert.ok(cloneRoute.includes('payload.append("tags", "tracer-drama-clone")'));
  assert.ok(voicesRoute.includes("listPrivateDramaCloneVoices(apiKey)"));
  assert.ok(voicesRoute.includes("privateDramaCloneCount"));
  assert.ok(privateCloneVoices.includes('model.visibility !== "private"'));
  assert.ok(privateCloneVoices.includes('tags.includes(DRAMA_CLONE_TAG)'));
});

test("BGM library is private, authenticated, paginated, and MP3 size bounded", () => {
  assert.ok(page.includes('id="bgmPanel"'));
  assert.ok(page.includes('id="bgmFiles"'));
  assert.ok(page.includes('id="uploadBgm"'));
  assert.ok(page.includes('multiple'));
  assert.ok(page.includes('id="bgmPreview"'));
  assert.ok(page.includes('id="bgmVolume"'));
  assert.ok(page.includes('id="bgmLoop"'));
  assert.ok(bgmRoute.includes('const BUCKET = "tracer-drama-bgm"'));
  assert.ok(bgmRoute.includes("MAX_FILE_BYTES = 10 * 1024 * 1024"));
  assert.ok(bgmRoute.includes("PAGE_SIZE = 100"));
  assert.ok(bgmRoute.includes("MAX_TRACKS = 1000"));
  assert.ok(bgmRoute.includes("await authorize(request)"));
  assert.ok(bgmRoute.includes("createSignedUrl"));
  assert.ok(bgmRoute.includes('contentType: "audio/mpeg"'));
});

test("finished drama mix combines dialogue with loopable BGM and fade automation", () => {
  assert.ok(page.includes('id="mixPanel"'));
  assert.ok(page.includes('id="mixExport"'));
  assert.ok(page.includes('id="mixBgmVolume"'));
  assert.ok(page.includes('id="mixFadeIn"'));
  assert.ok(page.includes('id="mixFadeOut"'));
  assert.ok(page.includes("async function createDramaMix"));
  assert.ok(page.includes("OfflineAudioContext"));
  assert.ok(page.includes("function encodeWav"));
  assert.ok(page.includes("music.loop=$(\"mixBgmLoop\").checked"));
  assert.ok(page.includes("linearRampToValueAtTime(0,duration)"));
  assert.ok(page.includes("const missing=expected.filter"));
  assert.ok(page.includes("duration>300"));
});

test("short drama studio inline JavaScript parses without syntax errors", () => {
  const scriptStart = page.indexOf("<script>");
  const scriptEnd = page.indexOf("</script>", scriptStart);
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "studio inline script exists");
  new Script(page.slice(scriptStart + "<script>".length, scriptEnd));
});

test("Fish Audio diagnostics are read-only, authenticated, and inspect wallet plus owned models", () => {
  assert.ok(page.includes('id="fishDiagnostics"'));
  assert.ok(page.includes('/api/admin/ai-live/fish-audio/diagnostics'));
  assert.ok(page.includes("APIクレジット残高"));
  assert.ok(diagnosticsRoute.includes('"/wallet/self/api-credit?check_free_credit=true"'));
  assert.ok(diagnosticsRoute.includes('"/wallet/self/package"'));
  assert.ok(diagnosticsRoute.includes('"/model?self=true&page_size=100'));
  assert.ok(diagnosticsRoute.includes("readOnly: true"));
  assert.ok(diagnosticsRoute.includes("Promise.allSettled"));
  assert.doesNotMatch(diagnosticsRoute, /method:\s*["']POST["']|FISH_MODEL_URL/);
});
