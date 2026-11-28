import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";

const page = readFileSync("public/ai-live-short-drama-studio.html", "utf8");
const lipSync = readFileSync("public/tracer-lip-sync.js", "utf8");
const route = readFileSync("app/api/admin/ai-live/fish-audio/route.ts", "utf8");
const childDesignRoute = readFileSync("app/api/admin/ai-live/fish-audio/child-voice-design/route.ts", "utf8");
const cloneRoute = readFileSync("app/api/admin/ai-live/fish-audio/clone/route.ts", "utf8");
const diagnosticsRoute = readFileSync("app/api/admin/ai-live/fish-audio/diagnostics/route.ts", "utf8");
const privateCloneVoices = readFileSync("lib/ai-live/fish-audio-private-drama-clone-voices.ts", "utf8");
const privateChildVoices = readFileSync("lib/ai-live/fish-audio-private-drama-voices.ts", "utf8");
const voicesRoute = readFileSync("app/api/admin/ai-live/fish-audio/voices/route.ts", "utf8");
const castRoute = readFileSync("app/api/admin/ai-live/short-drama/cast/route.ts", "utf8");
const castMigration = readFileSync("supabase/migrations/20261128043758_create_ai_live_drama_casts.sql", "utf8");
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
  assert.ok(page.includes("tracer-lip-sync.js"));
  assert.ok(page.includes("TracerLipSync.attachAligned"));
  assert.ok(page.includes("lipSyncMouth"));
  assert.ok(lipSync.includes("getByteTimeDomainData"));
  assert.ok(lipSync.includes("function attachAligned(audio, mouth, timeline)"));
  assert.ok(lipSync.includes("function buildVisemes(timeline)"));
  assert.ok(lipSync.includes('case "i": return { open: 0.34, wide: 1'));
  assert.ok(lipSync.includes('case "u": return { open: 0.38, wide: 0.08, round: 1'));
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
  assert.ok(route.includes("PROVIDER_TIMEOUT_MS = 50_000"));
  assert.ok(route.includes("/v1/tts/stream/with-timestamp"));
  assert.ok(route.includes("readTimestampedStream"));
  assert.ok(route.includes("alignmentUnit: \"word_or_text_segment\""));
  assert.ok(page.includes("withTimestamps:true"));
  assert.ok(page.includes("row.timeline=aligned.timeline"));
  assert.ok(page.includes("同期できない音声は採用しません"));
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
  assert.ok(page.includes('TRACER利用可能ボイス合計 '));
  assert.ok(page.includes('公開ライセンス '));
  assert.ok(page.includes('共通ID登録 '));
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



test("voice library keeps only Soma and Mitsuki as fixed character presets", () => {
  for (const name of ["蓮司","美月"]) assert.ok(page.includes('title:"'+name+'"'));
  assert.ok(!page.includes("凛"));
  assert.ok(page.includes('title:"蓮司"'));
  assert.ok(!page.includes("rin-preview.mp3"));
  assert.ok(!page.includes("renji-preview.mp3"));
  assert.ok(page.includes('Fish Audioモデル未接続'));
  assert.ok(page.includes('renderVoiceLibrary();'));
  assert.ok(!page.includes("data:audio/mpeg;base64,"));
  assert.doesNotMatch(page, /id="cloneAudio"|id="cloneRights"|id="registerClone"/);
});

test("BGM library is private, authenticated, lists Storage pages, and bounds MP3 size", () => {
  assert.ok(page.includes('id="bgmPanel"'));
  assert.ok(page.includes('id="bgmFiles"'));
  assert.ok(page.includes('id="uploadBgm"'));
  assert.ok(page.includes('multiple'));
  assert.ok(page.includes('id="bgmPreview"'));
  assert.ok(page.includes('id="bgmVolume"'));
  assert.ok(page.includes('id="bgmLoop"'));
  assert.ok(!page.includes("bgmComposer"));
  assert.ok(!page.includes("register-existing"));
  assert.ok(page.includes('body:file'));
  assert.ok(page.includes('"Content-Type":file.type||"audio/mpeg"'));
  assert.ok(page.includes('await selectBgm(true)'));
  assert.ok(page.includes('async function selectBgm(autoplay=false)'));
  assert.ok(page.includes('await bgmPreview.play()'));
  assert.ok(page.includes('method:"PUT"'));
  assert.ok(bgmRoute.includes('const BUCKET = "tracer-drama-bgm"'));
  assert.ok(bgmRoute.includes("MAX_FILE_BYTES = 10 * 1024 * 1024"));
  assert.ok(bgmRoute.includes("PAGE_SIZE = 100"));
  assert.ok(bgmRoute.includes("MAX_TRACKS = 1000"));
  assert.ok(bgmRoute.includes("await authorize(request)"));
  assert.ok(bgmRoute.includes("offset += PAGE_SIZE"));
  assert.ok(bgmRoute.includes("createSignedUploadUrl"));
  assert.ok(bgmRoute.includes("createSignedUrl"));
  assert.ok(!bgmRoute.includes("ai_live_bgm_rights"));
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


test("lip-sync video export records timestamp-driven mouth animation with synchronized dialogue and optional BGM", () => {
  assert.ok(page.includes('id="exportLipSyncVideo"'));
  assert.ok(page.includes('id="videoExportStatus"'));
  assert.ok(page.includes("async function exportLipSyncVideo()"));
  assert.ok(page.includes("row.timeline"));
  assert.ok(page.includes("canvas.captureStream(30)"));
  assert.ok(page.includes("new MediaRecorder(stream"));
  assert.ok(page.includes("source.start(audioStartAt+starts[index],0,buffers[index].duration)"));
  assert.ok(page.includes("video/mp4"));
  assert.ok(page.includes("video/webm"));
  assert.ok(page.includes("videoExportDownload"));
  assert.ok(page.includes("mouthX,mouthY,mw/2,mh/2"));
  assert.ok(page.includes("口の動きと字幕を映像に描画"));
  assert.ok(!page.includes("setTimeout("));
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
  assert.ok(diagnosticsRoute.includes("/model?self=true&page_size=${PAGE_SIZE}&page_number=1"));
  assert.ok(diagnosticsRoute.includes("readOnly: true"));
  assert.ok(diagnosticsRoute.includes("Promise.allSettled"));
  assert.doesNotMatch(diagnosticsRoute, /method:\s*["']POST["']|FISH_MODEL_URL/);
});


test("all drama audio playback surfaces attach the shared lip-sync engine", () => {
  assert.ok(page.includes('window.TracerLipSync.attachAligned(audio,mouth,row.timeline)'));
  assert.ok(page.includes('window.TracerLipSync.attachAligned(audio,el.querySelector(".lipSyncMouth"),row.timeline)'));
  assert.ok(page.includes('audio.play().catch(error=>{cleanup();reject(error);})'));
  assert.ok(page.includes('const audio=line?.querySelector("audio")'));
});

test("lip sync closes fully on silence, reacts quickly, and limits maximum opening", () => {
  assert.ok(lipSync.includes("getByteTimeDomainData"));
  assert.ok(lipSync.includes("getByteFrequencyData"));
  assert.ok(lipSync.includes("averageBand"));
  assert.ok(lipSync.includes("--lip-wide"));
  assert.ok(lipSync.includes("--lip-round"));
  assert.ok(lipSync.includes('target.style.setProperty("--lip-open"'));
  assert.ok(lipSync.includes("mouths: new Set()"));
  assert.ok(page.includes("height:calc(3px + 27px * var(--lip-open,0))"));
  assert.ok(page.includes("width:calc(25% + 27% * var(--lip-wide,0))"));
  assert.ok(page.includes('id="lipSyncGain"'));
});
test("output-list face mirrors sequential playback from the script-row audio", () => {
  assert.ok(page.includes("const sourceAudio=sourceLine?.querySelector(\"audio\")"));
  assert.ok(page.includes("window.TracerLipSync.attachAligned(sourceAudio,mouth,row.timeline)"));
});
test("voice preview cards attach the shared lip-sync engine", () => {
  assert.ok(page.includes("sampleFace=makeLipSyncFace"));
  assert.ok(page.includes("window.TracerLipSync.attach(player,sampleFace.querySelector(\".lipSyncMouth\"))"));
});

test("all voice catalogue entries offer explicit on-demand sample generation and playback", () => {
  assert.ok(page.includes("function addVoicePreviewControls(card,voice)"));
  assert.ok(page.includes("サンプル音声を生成して試聴"));
  assert.ok(page.includes("voicePreviewText"));
  assert.ok(page.includes('fetch("/api/admin/ai-live/fish-audio"'));
  assert.ok(page.includes("referenceId:voice.id"));
  assert.ok(page.includes("URL.createObjectURL(blob)"));
  assert.ok(page.includes("function showVoicePreview(root,voice,url)"));
  assert.ok(page.includes("const otherVoices=registered.filter"));
  assert.ok(page.includes("voicePreviewUrls"));
});
test("character reference image URLs are applied to face overlays and persisted in project data", () => {
  assert.ok(page.includes('class="cimage"'));
  assert.ok(page.includes("imageUrl:imageUrl||\"\""));
  assert.ok(page.includes("image.src=imageUrl"));
  assert.ok(page.includes('character.imageUrl==="string"'));
});

test("character mouth alignment is adjustable and persists through project export/import", () => {
  assert.ok(page.includes('class="mouthX"'));
  assert.ok(page.includes('class="mouthY"'));
  assert.ok(page.includes('style.setProperty("--mouth-x"'));
  assert.ok(page.includes('style.setProperty("--mouth-y"'));
  assert.ok(page.includes("mouthX:Number(mouthX)||50"));
  assert.ok(page.includes("mouthY:Number(mouthY)||65"));
  assert.ok(page.includes("character.mouthX,character.mouthY"));
});
test("replacing character preview faces detaches old mouth listeners before reattaching", () => {
  assert.ok(lipSync.includes("function detach(mouth)"));
  assert.ok(lipSync.includes("attachments.delete(mouth)"));
  assert.ok(page.includes("window.TracerLipSync?.detach(oldMouth)"));
  assert.ok(page.includes('for(const oldMouth of outputs.querySelectorAll(".lipSyncMouth"))'));
});
test("voice library reports all six source buckets and clarifies public count versus total", () => {
  assert.ok(page.includes("TRACER利用可能ボイス合計"));
  assert.ok(page.includes("公開ライセンス "));
  assert.ok(page.includes("共通ID登録 "));
  assert.ok(page.includes("許可確認済みクローン "));
  assert.ok(page.includes("ドラマ専用クローン "));
  assert.ok(page.includes("役別ID照合"));
  assert.ok(page.includes("架空の子供役 "));
  assert.ok(page.includes("重複IDは1回のみ計上"));
  assert.ok(page.includes("共通登録との重複を除外"));
  assert.ok(voicesRoute.includes("uniqueDramaCharacterVoices.length"));
  assert.ok(voicesRoute.includes("registeredVoiceCount: registeredVoices.length"));
});
test("character cards provide the correct Fish Audio connection path", () => {
  assert.ok(page.includes('{title:"美月",gender:"女性",description:"女性キャラクターボイス",modelId:"160840e5c583459d89dc5521e7f175e5"}'));
  assert.ok(page.includes('{title:"蓮司",gender:"男性",description:"男性キャラクターボイス",modelId:"7478a76f38974bd2afa89c1bbe6831c7"}'));
  assert.ok(page.includes('preset.modelId?"Fish Audio IDを照合して接続":"Fish AudioモデルIDを登録"'));
  assert.ok(page.includes('$("voiceModelId").value=preset.modelId||""'));
  assert.ok(page.includes('if(!found){const register=document.createElement("button")'));
});
test("Fish Audio diagnostics displays the actual scanned model count field", () => {
  assert.ok(page.includes('models.scannedCount??"不明"'));
  assert.ok(!page.includes('models.pageCount??"不明"'));
});

test("Fish Audio diagnostics directly verifies the two registered episode-one voice IDs without TTS", () => {
  assert.ok(diagnosticsRoute.includes("REGISTERED_DIAGNOSTIC_VOICES"));
  assert.ok(diagnosticsRoute.includes("fb10beaad13d434680248bfa5eeb566f"));
  assert.ok(diagnosticsRoute.includes("64eb21d34a75439f8cedfcd1640e838f"));
  assert.ok(diagnosticsRoute.includes("registeredVoiceChecks,"));
  assert.ok(page.includes("第1話の登録ボイスID直接照合（生成なし）"));
  assert.ok(page.includes("data.registeredVoiceChecks||[]"));
  assert.doesNotMatch(diagnosticsRoute, /FISH_TTS_URL|\/v1\/tts/);
});

test("Fish Audio diagnostics directly verifies each assigned character model ID", () => {
  assert.ok(diagnosticsRoute.includes("TRACER_DRAMA_CHARACTER_VOICES.map"));
  assert.ok(diagnosticsRoute.includes("resolveFishAudioModelVoice(apiKey, character.id, character.title)"));
  assert.ok(diagnosticsRoute.includes('status: voice.status === "fulfilled" && voice.value ? "accessible" : "not_accessible"'));
  assert.ok(diagnosticsRoute.includes('fishGet(`/model/${encodeURIComponent(character.id)}`, apiKey)'));
  assert.ok(diagnosticsRoute.includes("samples,"));
  assert.ok(page.includes("provider.samples||[]"));
  assert.ok(diagnosticsRoute.includes("assignedCharacterVoices,"));
  assert.ok(page.includes("TRACER看板キャラクターIDの直接照合"));
  assert.ok(page.includes('character.status==="not_accessible"'));
});

test("BGM uploads use an authenticated signed-URL preparation step and bypass Vercel body limits", () => {
  assert.ok(bgmRoute.includes('body.action !== "prepare"'));
  assert.ok(bgmRoute.includes("createSignedUploadUrl(objectName"));
  assert.ok(bgmRoute.includes("MAX_FILE_BYTES"));
  assert.ok(!bgmRoute.includes("request.formData()"));
  assert.ok(!bgmRoute.includes("file.arrayBuffer()"));
  assert.ok(page.includes('action:"prepare"'));
  assert.ok(page.includes('method:"PUT"'));
  assert.ok(page.includes("data.upload.url"));
  assert.ok(!page.includes("/api/admin/ai-live/short-drama/bgm/register-existing"));
  assert.ok(!page.includes('form.append("file",file,file.name)'));
});


test("studio lip sync has a visibly larger mouth and a working opening-strength control", () => {
  assert.ok(page.includes("width:84px;height:84px;flex:0 0 84px;"));
  assert.ok(page.includes('value="75"><p class="muted">口の開き幅を調整できます。発話中は大きく開き'));
  assert.ok(page.includes('lipSyncGainInput.addEventListener("input",applyLipSyncGain)'));
  assert.ok(page.includes("window.TracerLipSync?.setGain(value/67)"));
  assert.ok(lipSync.includes("let gain = 1.12"));
  assert.ok(lipSync.includes("clamp((rms - 0.009) * 17 * gain, 0, 1)"));
});

test("custom registered voices can be removed from TRACER without deleting Fish Audio models or saved cast IDs", () => {
  assert.ok(page.includes("async function removeRegisteredVoice(voice)"));
  assert.ok(page.includes('method:"DELETE"'));
  assert.ok(page.includes('textContent="この声を一覧から削除"'));
  assert.ok(page.includes("Fish Audio側のモデルと過去のドラマ配役は削除しません"));
  assert.ok(voicesRoute.includes("export async function DELETE(request: Request)"));
  assert.ok(voicesRoute.includes('from("fish_audio_registered_voices").delete()'));
  assert.ok(voicesRoute.includes("protectedIds"));
  assert.ok(page.includes("削除済み・未登録ボイス（既存配役IDを保持）"));
});
test("drama cast is persisted by title and can be restored for later episodes", () => {
  assert.ok(page.includes('id="saveDramaCast"'));
  assert.ok(page.includes('id="loadDramaCast"'));
  assert.ok(page.includes("async function saveDramaCast()"));
  assert.ok(page.includes("async function loadDramaCast()"));
  assert.ok(page.includes("/api/admin/ai-live/short-drama/cast"));
  assert.ok(page.includes("保存済みの配役を呼び出す"));
  assert.ok(page.includes("refreshLineCharacters();refreshCharacterFaces();"));
  assert.ok(castRoute.includes('from("ai_live_drama_casts")'));
  assert.ok(castRoute.includes("export async function GET(request: Request)"));
  assert.ok(castRoute.includes("export async function POST(request: Request)"));
  assert.ok(castRoute.includes("dramaKey(title)"));
  assert.ok(castMigration.includes("create table if not exists public.ai_live_drama_casts"));
  assert.ok(castMigration.includes("enable row level security"));
  assert.ok(castMigration.includes("revoke all on public.ai_live_drama_casts from anon, authenticated"));
});
