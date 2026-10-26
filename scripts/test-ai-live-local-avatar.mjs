import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./ai-live-local-avatar.html", import.meta.url), "utf8");
assert.match(html, /lang="ja"/);
assert.match(html, /speechSynthesis/);
assert.match(html, /utterance\.lang = "ja-JP"/);
assert.match(html, /LOCAL-ONLY PROTOTYPE/);
assert.match(html, /架空データ/);
assert.match(html, /data-type="price"/);
assert.match(html, /data-type="features"/);
assert.match(html, /data-type="availability"/);
assert.match(html, /data-type="purchase"/);
assert.match(html, /data-type="unknown"/);
assert.doesNotMatch(html, /fetch\s*\(|WebSocket\s*\(|EventSource\s*\(|createSupabaseAdminClient|process\.env/);
console.log("AI-live local avatar contract: 12 assertions passed");
