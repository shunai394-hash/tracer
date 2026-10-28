import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);

const routePath = new URL("../app/api/admin/ai-live/eleven-v4-turbo/route.ts", import.meta.url);
const routeSource = readFileSync(routePath, "utf8");
const page = readFileSync(new URL("../public/ai-live-eleven-preview.html", import.meta.url), "utf8");
const canonicalPreview = readFileSync(new URL("../public/ai-live-preview.html", import.meta.url), "utf8");
const KIYOMI_VOICE_ID = "pdJqk51tDVoes2IzwOyU";
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

assert.match(routeSource, /import \{ timingSafeEqual \} from "node:crypto";/u);
assert.match(routeSource, /process\.env\.TRACER_ADMIN_TOKEN/u);
assert.match(routeSource, /authorizedAdminToken\(request\)/u);
assert.match(routeSource, /timingSafeEqual\(expectedBytes, suppliedBytes\)/u);
assert.match(routeSource, /requireAutomationAuth\(request\)/u);
assert.match(routeSource, /process\.env\.ELEVENLABS_API_KEY/u);
assert.match(routeSource, /error: "elevenlabs_not_configured"/u);
assert.match(routeSource, /"elevenlabs_timeout"/u);
assert.match(routeSource, /"empty_audio_response"/u);
assert.match(routeSource, /error: "text_length_out_of_range"/u);
assert.match(routeSource, /error: "valid_voice_id_required"/u);
assert.match(routeSource, /"Content-Type": "audio\/mpeg"/u);
assert.match(routeSource, /not automatically retried/u);
assert.doesNotMatch(routeSource, /console\.(log|debug|info|warn|error)\(/u);
assert.doesNotMatch(routeSource, /NEXT_PUBLIC_ELEVENLABS|localStorage|sessionStorage/u);
assert.equal(routeSource.split("new WebSocket(").length - 1, 1);
const adminGate = routeSource.indexOf("if (!authorizedAdminToken(request))");
const automationGate = routeSource.indexOf("requireAutomationAuth(request)", adminGate);
assert.ok(adminGate > 0 && automationGate > adminGate);

assert.match(page, /<meta name="robots" content="noindex,nofollow">/);
assert.match(page, /type="password"/);
assert.match(page, new RegExp(`value="${KIYOMI_VOICE_ID}"`));
assert.match(page, /こんにちは、TRACER AI配信です。/);
assert.match(page, /<textarea id="script"/);
assert.match(page, /fetch\("\/api\/admin\/ai-live\/eleven-v4-turbo"/);
assert.match(page, /voiceId/);
assert.match(page, /<audio id="audio"/);
assert.match(page, /認証に失敗しました。管理トークンを確認してください。/);
assert.match(page, /サーバーにElevenLabsのAPIキーが設定されていません。/);
assert.match(page, /音声生成がタイムアウトしました。自動では再試行しません。/);
assert.match(page, /音声データが空でした。自動では再試行しません。/);
assert.match(page, /if \(pending\) return;/);
assert.match(page, /button\.disabled = true/);
assert.match(page, /localStorage、sessionStorage、URLには保存しません/);
assert.doesNotMatch(page, /\b(?:localStorage|sessionStorage)\s*\./);
assert.doesNotMatch(page, /document\.cookie|location\.(?:href|search|hash)|URLSearchParams|history\.pushState/);
assert.doesNotMatch(page, /ELEVENLABS_API_KEY|CRON_SECRET|NEXT_PUBLIC_|ACTIONS_ID_TOKEN|xi_api_key/);
assert.doesNotMatch(page, /wss:\/\/api\.elevenlabs\.io|setInterval|setTimeout/);
assert.doesNotMatch(page, /console\.(log|debug|info|warn|error)\(/);
const submitAt = page.indexOf('addEventListener("submit"');
const fetchAt = page.indexOf("fetch(");
assert.ok(submitAt !== -1 && fetchAt > submitAt);
assert.equal(page.indexOf("fetch(", fetchAt + 1), -1);

assert.match(canonicalPreview, /架空のデモデータ/);
assert.doesNotMatch(canonicalPreview, /fetch\s*\(|WebSocket|EventSource|eleven-v4-turbo|ELEVENLABS_API_KEY/);

const compiled = ts.transpileModule(routeSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
}).outputText;
const shimmed = compiled
  .replace(/require\("next\/server"\)/g, "({ NextResponse })")
  .replace(/require\("@\/lib\/security\/cron-auth"\)/g, "({ requireAutomationAuth })");

class NextResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Map(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  }

  static json(body, init = {}) {
    const response = new NextResponse(body, init);
    if (!response.headers.has("content-type")) response.headers.set("content-type", "application/json");
    return response;
  }
}

const automation = { calls: 0, allow: false };
async function requireAutomationAuth() {
  automation.calls += 1;
  if (automation.allow) return null;
  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

const loaded = { exports: {} };
const runner = new Function("exports", "require", "module", "NextResponse", "requireAutomationAuth", shimmed);
runner(loaded.exports, nodeRequire, loaded, NextResponse, requireAutomationAuth);
const { POST } = loaded.exports;

class FakeSocket extends EventTarget {
  static sockets = [];
  static mode = "success";
  static audioBytes = Uint8Array.from([255, 251, 144, 100, 1, 2, 3, 4]);

  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = FakeSocket.CONNECTING;
    this.sent = [];
    FakeSocket.sockets.push(this);
    queueMicrotask(() => {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.close_socket !== true) return;
    if (FakeSocket.mode === "success") {
      this.emit({ audio: Buffer.from(FakeSocket.audioBytes).toString("base64") });
      this.emit({ is_final: true });
    } else if (FakeSocket.mode === "empty") {
      this.emit({ is_final: true });
    } else if (FakeSocket.mode === "reject") {
      this.emit({ error: "voice_not_found" });
    } else if (FakeSocket.mode === "oversize") {
      this.emit({ audio: Buffer.alloc(MAX_AUDIO_BYTES + 1, 7).toString("base64") });
    }
  }

  emit(payload) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: JSON.stringify(payload) });
    this.dispatchEvent(event);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}
FakeSocket.CONNECTING = 0;
FakeSocket.OPEN = 1;
FakeSocket.CLOSING = 2;
FakeSocket.CLOSED = 3;

const originalWebSocket = globalThis.WebSocket;
const originalAdmin = process.env.TRACER_ADMIN_TOKEN;
const originalKey = process.env.ELEVENLABS_API_KEY;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function requestFor({ authorization = undefined, body = undefined, raw = undefined, jsonThrows = false } = {}) {
  return {
    headers: {
      get(name) {
        if (String(name).toLowerCase() !== "authorization") return null;
        return authorization === undefined ? null : authorization;
      },
    },
    async json() {
      if (jsonThrows) throw new Error("body should not be read");
      if (raw instanceof Error) throw raw;
      if (raw !== undefined) return raw;
      return body;
    },
  };
}

function validBody(overrides = {}) {
  return {
    text: "こんにちは。清美の音声テストです。",
    voiceId: KIYOMI_VOICE_ID,
    ...overrides,
  };
}

async function post(options) {
  FakeSocket.sockets = [];
  return POST(requestFor(options));
}

async function waitForSocket() {
  for (let attempt = 0; attempt < 20 && FakeSocket.sockets.length === 0; attempt += 1) {
    await new Promise((resolve) => queueMicrotask(resolve));
  }
}

try {
  globalThis.WebSocket = FakeSocket;
  process.env.TRACER_ADMIN_TOKEN = "admin-token-value";
  process.env.ELEVENLABS_API_KEY = "server-side-elevenlabs-key";
  automation.allow = false;
  FakeSocket.mode = "success";

  const missingAuth = await post({ body: validBody(), jsonThrows: true });
  assert.equal(missingAuth.status, 401);
  assert.equal(missingAuth.body.error, "Unauthorized");
  assert.equal(automation.calls, 1);
  assert.equal(FakeSocket.sockets.length, 0);

  automation.calls = 0;
  const wrongToken = await post({
    authorization: "Bearer not-the-admin-token",
    body: validBody(),
    jsonThrows: true,
  });
  assert.equal(wrongToken.status, 401);
  assert.equal(automation.calls, 1);
  assert.equal(FakeSocket.sockets.length, 0);

  automation.calls = 0;
  const shortToken = await post({
    authorization: "Bearer short",
    body: validBody(),
    jsonThrows: true,
  });
  assert.equal(shortToken.status, 401);
  assert.equal(automation.calls, 1);

  automation.calls = 0;
  const tokenInBodyOnly = await post({
    body: { ...validBody(), token: "admin-token-value" },
    jsonThrows: false,
  });
  assert.equal(tokenInBodyOnly.status, 401);
  assert.equal(automation.calls, 1);
  assert.equal(FakeSocket.sockets.length, 0);

  automation.calls = 0;
  automation.allow = true;
  delete process.env.ELEVENLABS_API_KEY;
  const automationWithoutKey = await post({
    authorization: "Bearer valid-automation",
    body: validBody(),
    jsonThrows: true,
  });
  assert.equal(automationWithoutKey.status, 503);
  assert.equal(automationWithoutKey.body.error, "elevenlabs_not_configured");
  assert.equal(automation.calls, 1);
  assert.equal(FakeSocket.sockets.length, 0);
  assert.equal(JSON.stringify(automationWithoutKey.body).includes("valid-automation"), false);

  automation.calls = 0;
  automation.allow = false;
  delete process.env.ELEVENLABS_API_KEY;
  const adminWithoutKey = await post({
    authorization: "Bearer admin-token-value",
    jsonThrows: true,
  });
  assert.equal(adminWithoutKey.status, 503);
  assert.equal(adminWithoutKey.body.error, "elevenlabs_not_configured");
  assert.equal(automation.calls, 0);
  assert.equal(FakeSocket.sockets.length, 0);

  process.env.ELEVENLABS_API_KEY = "server-side-elevenlabs-key";
  const invalidJson = await post({
    authorization: "Bearer admin-token-value",
    raw: new Error("bad json"),
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.error, "invalid_json");
  assert.equal(FakeSocket.sockets.length, 0);

  const invalidObject = await post({
    authorization: "Bearer admin-token-value",
    raw: ["not", "an", "object"],
  });
  assert.equal(invalidObject.status, 400);
  assert.equal(invalidObject.body.error, "invalid_json_object");

  for (const text of ["", "   ", "あ".repeat(1201)]) {
    const rejected = await post({
      authorization: "Bearer admin-token-value",
      body: validBody({ text }),
    });
    assert.equal(rejected.status, 400, `text ${JSON.stringify(text).slice(0, 24)}`);
    assert.equal(rejected.body.error, "text_length_out_of_range");
    assert.equal(FakeSocket.sockets.length, 0);
  }

  for (const voiceId of ["", "short", "bad id!!", "音声アイディーです"]) {
    const rejected = await post({
      authorization: "Bearer admin-token-value",
      body: validBody({ voiceId }),
    });
    assert.equal(rejected.status, 400, voiceId);
    assert.equal(rejected.body.error, "valid_voice_id_required");
    assert.equal(FakeSocket.sockets.length, 0);
  }

  const audio = await post({
    authorization: "Bearer   admin-token-value  ",
    body: validBody({ text: "あ".repeat(1200), voiceId: "voice_123" }),
  });
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/mpeg");
  assert.equal(audio.headers.get("x-ai-voice-model"), "eleven_v4_turbo");
  assert.equal(audio.headers.get("cache-control"), "no-store");
  assert.equal(audio.headers.get("content-length"), String(FakeSocket.audioBytes.byteLength));
  assert.deepEqual([...new Uint8Array(audio.body)], [...FakeSocket.audioBytes]);
  assert.equal(automation.calls, 0);
  assert.equal(FakeSocket.sockets.length, 1);
  const socket = FakeSocket.sockets[0];
  assert.match(socket.url, /model_id=eleven_v4_turbo/);
  assert.match(socket.url, /output_format=mp3_44100_128/);
  assert.deepEqual(socket.sent[0].voices, ["voice_123"]);
  assert.equal(socket.sent[0].xi_api_key, "server-side-elevenlabs-key");
  assert.equal(socket.sent[1].inputs[0].text, "あ".repeat(1200));
  assert.equal(socket.sent[2].close_socket, true);
  const httpBody = Buffer.from(audio.body).toString("utf8");
  assert.equal(httpBody.includes("server-side-elevenlabs-key"), false);
  assert.equal(httpBody.includes("admin-token-value"), false);

  automation.allow = true;
  automation.calls = 0;
  const oidcAudio = await post({
    authorization: "Bearer github-oidc-token",
    body: validBody(),
  });
  assert.equal(oidcAudio.status, 200);
  assert.equal(automation.calls, 1);
  assert.equal(FakeSocket.sockets.length, 1);
  automation.allow = false;

  FakeSocket.mode = "empty";
  const emptyAudio = await post({
    authorization: "Bearer admin-token-value",
    body: validBody(),
  });
  assert.equal(emptyAudio.status, 502);
  assert.equal(emptyAudio.body.error, "empty_audio_response");
  assert.equal(emptyAudio.body.generationStarted, true);
  assert.match(emptyAudio.body.message, /not automatically retried/);
  assert.equal(FakeSocket.sockets.length, 1);

  FakeSocket.mode = "reject";
  const rejectedProvider = await post({
    authorization: "Bearer admin-token-value",
    body: validBody(),
  });
  assert.equal(rejectedProvider.status, 502);
  assert.equal(rejectedProvider.body.error, "elevenlabs_unavailable");
  assert.equal(FakeSocket.sockets.length, 1);
  assert.equal(JSON.stringify(rejectedProvider.body).includes("voice_not_found"), false);

  FakeSocket.mode = "oversize";
  const oversized = await post({
    authorization: "Bearer admin-token-value",
    body: validBody(),
  });
  assert.equal(oversized.status, 502);
  assert.equal(oversized.body.error, "audio_size_out_of_range");
  assert.equal(FakeSocket.sockets.length, 1);

  FakeSocket.mode = "timeout";
  const scheduled = [];
  globalThis.setTimeout = (fn, ms) => {
    const id = scheduled.length + 1;
    scheduled.push({ id, fn, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const index = scheduled.findIndex((item) => item.id === id);
    if (index >= 0) scheduled.splice(index, 1);
  };
  const pendingTimeout = post({
    authorization: "Bearer admin-token-value",
    body: validBody(),
  });
  await waitForSocket();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 25_000);
  assert.equal(FakeSocket.sockets.length, 1);
  scheduled[0].fn();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  const timedOut = await pendingTimeout;
  assert.equal(timedOut.status, 502);
  assert.equal(timedOut.body.error, "elevenlabs_timeout");
  assert.match(timedOut.body.message, /not automatically retried/);
  assert.equal(FakeSocket.sockets.length, 1);
} finally {
  globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  if (originalAdmin === undefined) delete process.env.TRACER_ADMIN_TOKEN;
  else process.env.TRACER_ADMIN_TOKEN = originalAdmin;
  if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalKey;
}

console.log("AI-live ElevenLabs admin preview auth, validation, and audio response checks passed.");
