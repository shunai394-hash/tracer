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
assert.match(preview, /speechSynthesis\.speak/);
assert.match(preview, /speechSynthesis\.cancel/);
assert.match(preview, /data-type="price"/);
assert.match(preview, /data-type="features"/);
assert.match(preview, /data-type="stock"/);
assert.match(preview, /data-type="delivery"/);
assert.match(preview, /aria-live="polite"/);
assert.match(preview, /id="stop"/);
assert.match(preview, /実際の在庫を確認していません/);
assert.doesNotMatch(preview, /fetch\s*\(|WebSocket|EventSource|https?:\/\//);
assert.doesNotMatch(preview, /src=["']https?:/);
console.log("AI-live local rehearsal and avatar preview safety contract: 35 assertions passed");
