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

const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/ai-live-local-demo.mjs"], {
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
assert.equal(report.sharedProductionLogic, true);
assert.equal(report.commentCount, 5);
assert.equal(report.results.length, 5);
for (const result of report.results) {
  assert.equal(typeof result.answer, "string");
  assert.ok(result.answer.length > 0);
  assert.equal(result.spokenAudio, false);
  assert.equal(typeof result.category, "string");
  assert.equal(typeof result.routeAction, "string");
  assert.equal(typeof result.replyAction, "string");
  assert.ok(result.note.includes("共有ルーター"));
}
assert.match(report.results.find((item) => item.commentType === "unknown").answer, /確認できません/);

const deployedPreview = readFileSync(new URL("../public/ai-live-preview.html", import.meta.url), "utf8");
assert.match(deployedPreview, /<meta name="robots" content="noindex,nofollow">/);
assert.match(deployedPreview, /架空のデモデータ/);
assert.match(deployedPreview, /id="soak30"/);
assert.match(deployedPreview, /id="soak60"/);
assert.match(deployedPreview, /id="stopSoak"/);
assert.match(deployedPreview, /setInterval\(speakNext, 45000\)/);
assert.match(deployedPreview, /minutes \* 60 \* 1000/);
assert.match(deployedPreview, /連続テストを手動停止/);
assert.doesNotMatch(deployedPreview, /fetch\s*\(|WebSocket|EventSource|https?:\/\//);
const dramaPreview = readFileSync(new URL("../public/ai-live-drama-preview.html", import.meta.url), "utf8");
assert.match(deployedPreview, /href="\/ai-live-drama-preview\.html"/);
assert.match(dramaPreview, /<meta name="robots" content="noindex,nofollow">/);
assert.match(dramaPreview, /fetch\("\/api\/admin\/ai-live\/fish-drama-3"/);
assert.match(dramaPreview, /Authorization.*Bearer/);
assert.match(dramaPreview, /referenceId/);
assert.match(dramaPreview, /audio\/mpeg|audio\//);
assert.doesNotMatch(dramaPreview, /FISH_API_KEY|NEXT_PUBLIC_FISH_API_KEY|\b(?:localStorage|sessionStorage)\s*\./);
assert.match(dramaPreview, /URL\.revokeObjectURL/);
console.log("AI-live local and explicit Drama 3 preview safety contracts passed");
