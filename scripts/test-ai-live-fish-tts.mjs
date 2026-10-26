import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const server = readFileSync(new URL("./ai-live-fish-tts-server.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("./ai-live-fish-session.html", import.meta.url), "utf8");
for (const pattern of [/127\.0\.0\.1/,/FISH_AUDIO_API_KEY/,/api\.fish\.audio\/v1\/tts/,/model: "drama-3"/,/AbortSignal\.timeout/,/parsed\.text\.length > 1500/,/Buffer\.byteLength\(body\) > 12_000/,/Authorization:/,/Not found/,/maxAudioBytes = 25 \* 1024 \* 1024/,/for await \(const chunk of upstream\.body\)/,/AUDIO_TOO_LARGE/,/Buffer\.concat\(chunks, audioBytes\)/]) assert.match(server, pattern);
for (const pattern of [/lang="ja"/,/fetch\('\/api\/tts'/,/Drama 3で生成して再生/,/ブラウザ音声で再生/,/maxlength="1200"/,/beforeunload/]) assert.match(html, pattern);
assert.doesNotMatch(html, /Bearer\s+[A-Za-z0-9_-]{12,}/);
assert.doesNotMatch(server, /0\.0\.0\.0/);
console.log("AI-live Fish Audio local integration contract: 20 assertions passed");
