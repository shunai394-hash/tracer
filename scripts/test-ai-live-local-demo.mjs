import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const script = readFileSync(new URL("./ai-live-local-demo.mjs", import.meta.url), "utf8");
assert.match(script, /local-only AI-live rehearsal/i);
assert.match(script, /networkAccess: false/);
assert.match(script, /databaseAccess: false/);
assert.match(script, /commerceWrites: false/);
assert.match(script, /publicStreaming: false/);
assert.doesNotMatch(script, /fetch\s*\(|https?\.request|createSupabaseAdminClient|process\.env/);

const run = spawnSync(process.execPath, ["scripts/ai-live-local-demo.mjs"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
assert.equal(run.status, 0, run.stderr);
const report = JSON.parse(run.stdout);
assert.equal(report.mode, "local-only");
assert.equal(report.demoOnly, true);
assert.equal(report.networkAccess, false);
assert.equal(report.databaseAccess, false);
assert.equal(report.commerceWrites, false);
assert.equal(report.publicStreaming, false);
assert.equal(report.commentCount, 5);
assert.equal(report.results.length, 5);
for (const result of report.results) {
  assert.equal(typeof result.answer, "string");
  assert.ok(result.answer.length > 0);
  assert.equal(result.spokenAudio, false);
}
assert.match(report.results.find((item) => item.commentType === "unknown").answer, /確認できません/);

const preview = readFileSync(new URL("./ai-live-avatar-preview.html", import.meta.url), "utf8");
assert.match(preview, /<html lang="ja">/);
assert.match(preview, /MOCK DATA · NO NETWORK/);
assert.match(preview, /SpeechSynthesisUtterance/);
assert.match(preview, /id="voiceSelect"/);
assert.match(preview, /getVoices\(\)/);
assert.match(preview, /voiceURI === voiceSelect\.value/);
assert.match(preview, /日本語音声が見つかりません/);
assert.match(preview, /speechSynthesis\.speak/);
assert.match(preview, /speechSynthesis\.cancel/);
assert.match(preview, /data-type="price"/);
assert.match(preview, /data-type="features"/);
assert.match(preview, /data-type="stock"/);
assert.match(preview, /data-type="delivery"/);
assert.match(preview, /aria-live="polite"/);
assert.match(preview, /id="stop"/);
assert.match(preview, /id="soak30"/);
assert.match(preview, /id="soak60"/);
assert.match(preview, /id="stopSoak"/);
assert.match(preview, /setInterval\(speakNext, 45000\)/);
assert.match(preview, /minutes \* 60 \* 1000/);
assert.match(preview, /連続テストを手動停止/);
assert.match(preview, /実際の在庫を確認していません/);
assert.doesNotMatch(preview, /fetch\s*\(|WebSocket|EventSource|https?:\/\//);
assert.doesNotMatch(preview, /src=["']https?:/);
const deployedPreview = readFileSync(new URL("../public/ai-live-preview.html", import.meta.url), "utf8");
assert.match(deployedPreview, /<meta name="robots" content="noindex,nofollow">/);
assert.match(deployedPreview, /架空のデモデータ/);
assert.match(deployedPreview, /id="soak30"/);
assert.match(deployedPreview, /id="soak60"/);
assert.match(deployedPreview, /id="stopSoak"/);
assert.match(deployedPreview, /setInterval\\(speakNext, 45000\\)/);
assert.match(deployedPreview, /minutes \\* 60 \\* 1000/);
assert.match(deployedPreview, /連続テストを手動停止/);
assert.doesNotMatch(deployedPreview, /fetch\\s*\\(|WebSocket|EventSource|https?:\\/\\//);
console.log("AI-live local rehearsal and both preview safety contracts: 54 assertions passed");
