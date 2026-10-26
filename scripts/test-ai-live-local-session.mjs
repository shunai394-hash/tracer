import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html=readFileSync(new URL("./ai-live-local-session.html",import.meta.url),"utf8");
for (const pattern of [/lang="ja"/,/speechSynthesis/,/u\.lang="ja-JP"/,/networkAccess:false/,/databaseAccess:false/,/commerceWrites:false/,/publicStreaming:false/,/tracer-ai-live-local-report\.json/,/data-kind="price"/,/data-kind="features"/,/data-kind="stock"/,/data-kind="buy"/,/data-kind="unknown"/,/計測開始/,/計測終了・JSON保存/]) assert.match(html,pattern);
assert.doesNotMatch(html,/fetch\s*\(|WebSocket\s*\(|EventSource\s*\(|createSupabaseAdminClient|process\.env/);
console.log("AI-live local session safety contract: 15 assertions passed");
