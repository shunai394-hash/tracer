import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const routePath = new URL("../app/api/admin/ai-live/sfx-v3/route.ts", import.meta.url);
const source = readFileSync(routePath, "utf8");
const page = readFileSync(new URL("../public/ai-live-sfx-v3-preview.html", import.meta.url), "utf8");

assert.match(source, /eleven_text_to_sound_v3/u);
assert.match(source, /process\.env\.ELEVENLABS_API_KEY/u);
assert.match(source, /process\.env\.TRACER_ADMIN_TOKEN/u);
assert.match(source, /requireAutomationAuth\(request\)/u);
assert.match(source, /timingSafeEqual/u);
assert.match(source, /MAX_DURATION_SECONDS = 8/u);
assert.match(source, /MAX_AUDIO_BYTES = 12 \* 1024 \* 1024/u);
assert.match(source, /getReader\(\)/u);
assert.match(source, /Math\.ceil\(durationSeconds \* 40\)/u);
assert.match(source, /not automatically retried/u);
assert.doesNotMatch(source, /response\.arrayBuffer\(\)/u);
assert.doesNotMatch(source, /console\.(log|debug|info|warn|error)\(/u);
assert.match(page, /<meta name="robots" content="noindex,nofollow">/u);
assert.match(page, /api\/admin\/ai-live\/sfx-v3/u);
assert.match(page, /window\.confirm/u);
assert.match(page, /雨の日の玄関/u);
assert.match(page, /夏祭り/u);
assert.doesNotMatch(page, /localStorage|sessionStorage|ELEVENLABS_API_KEY|xi-api-key|console\.(log|debug|info|warn|error)\(/u);

const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const shimmed = compiled
  .replace(/require\("next\/server"\)/g, "({ NextResponse })")
  .replace(/require\("@\/lib\/security\/cron-auth"\)/g, "({ requireAutomationAuth })");

class NextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  static json(body, init = {}) {
    const response = new NextResponse(body, init);
    response.body = body;
    return response;
  }
}
const auth = { calls: 0, allow: false };
async function requireAutomationAuth() {
  auth.calls += 1;
  return auth.allow ? null : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
const loaded = { exports: {} };
new Function("exports", "require", "module", "NextResponse", "requireAutomationAuth", shimmed)(
  loaded.exports, nodeRequire, loaded, NextResponse, requireAutomationAuth,
);
const { POST } = loaded.exports;
const originalFetch = globalThis.fetch;
const originalAdmin = process.env.TRACER_ADMIN_TOKEN;
const originalKey = process.env.ELEVENLABS_API_KEY;
function request({ token, body }) {
  return {
    headers: { get: (name) => name.toLowerCase() === "authorization" ? (token ? `Bearer ${token}` : null) : null },
    json: async () => body,
  };
}
try {
  process.env.TRACER_ADMIN_TOKEN = "admin-secret";
  process.env.ELEVENLABS_API_KEY = "eleven-secret";
  auth.calls = 0;
  let providerCalls = 0;
  globalThis.fetch = async (url, init) => {
    providerCalls += 1;
    assert.match(String(url), /output_format=mp3_44100_128/u);
    assert.equal(init.headers["xi-api-key"], "eleven-secret");
    const payload = JSON.parse(init.body);
    assert.equal(payload.model_id, "eleven_text_to_sound_v3");
    assert.equal(payload.duration_seconds, 6);
    return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  };

  const denied = await POST(request({ body: { text: "Rain in a quiet room" } }));
  assert.equal(denied.status, 401);
  assert.equal(providerCalls, 0);
  assert.equal(auth.calls, 1);

  const invalid = await POST(request({ token: "admin-secret", body: { text: "  ", durationSeconds: 6 } }));
  assert.equal(invalid.status, 400);
  assert.equal(providerCalls, 0);

  const tooLong = await POST(request({ token: "admin-secret", body: { text: "x".repeat(601) } }));
  assert.equal(tooLong.status, 400);
  assert.equal(providerCalls, 0);

  const durationRejected = await POST(request({ token: "admin-secret", body: { text: "Rain", durationSeconds: 9 } }));
  assert.equal(durationRejected.status, 400);
  assert.equal(providerCalls, 0);

  const success = await POST(request({ token: "admin-secret", body: { text: "Rain on a window in a quiet Japanese apartment" } }));
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("x-ai-sfx-model"), "eleven_text_to_sound_v3");
  assert.equal(success.headers.get("x-ai-sfx-credits-cap"), "240");
  assert.deepEqual([...new Uint8Array(success.body)], [1, 2, 3]);
  assert.equal(providerCalls, 1);

  globalThis.fetch = async () => new Response("account detail must not leak", { status: 404 });
  const unavailable = await POST(request({ token: "admin-secret", body: { text: "Train crossing bell" } }));
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.body.error, "elevenlabs_request_rejected");
  assert.equal(JSON.stringify(unavailable.body).includes("account detail"), false);
  assert.equal(providerCalls, 1);

  let oversizedCalls = 0;
  globalThis.fetch = async () => {
    oversizedCalls += 1;
    return new Response(new Uint8Array(12 * 1024 * 1024 + 1), { status: 200 });
  };
  const oversized = await POST(request({ token: "admin-secret", body: { text: "Oversized audio test" } }));
  assert.equal(oversized.status, 502);
  assert.equal(oversized.body.error, "audio_size_out_of_range");
  assert.equal(oversizedCalls, 1);
} finally {
  globalThis.fetch = originalFetch;
  if (originalAdmin === undefined) delete process.env.TRACER_ADMIN_TOKEN;
  else process.env.TRACER_ADMIN_TOKEN = originalAdmin;
  if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalKey;
}
console.log("AI-live SFX v3 auth, cost cap, bounded streaming, validation, and no-retry checks passed.");
