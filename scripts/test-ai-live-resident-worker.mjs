import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDestinationSocket } from "../lib/ai-live/destination-gate.ts";
import { compareProductFacts } from "../lib/ai-live/product-facts-check.ts";
import { resolveWorkerAdminToken, tokensMatch, workerAuthSource } from "../lib/ai-live/resident-auth.ts";
import { buildResidentFfmpegArgs, isRegisteredResidentVoice, residentMixGains, synthesizeRegisteredVoice } from "../lib/ai-live/resident-media.ts";
import { killProcessTree } from "../lib/ai-live/resident-process.ts";
import { SPEECH_DUCK_RATIO } from "../lib/ai-live/program.ts";
import { ResidentSession } from "../lib/ai-live/resident-worker.ts";

const adminToken = "resident-admin-test-token";
const wrongToken = "wrong-admin-token-value";
const productsToken = "products-read-token";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const now = new Date();
const factsAt = now.toISOString();
const job = {
  streamId: "live-session-1",
  destination: "loopback",
  destinationSecretRef: "worker-secret-slot",
  maxRuntimeSeconds: 600,
  segments: [{
    id: "segment-1",
    productId: "bag-1",
    scriptText: "レザー調 レディースハンドバッグです。価格は12,800円です。",
    factsVersion: "v1",
    factsVerifiedAt: factsAt,
  }],
};

const session = new ResidentSession();
const started = session.start(job, factsAt);
assert.equal(started.ok, true);
assert.equal(started.health.state, "live");
assert.equal(started.health.publicBroadcast, false);
assert.equal(session.start(job, factsAt).idempotent, true);
assert.equal(session.start({ ...job, streamId: "other-session" }, factsAt).errorCode, "duplicate_stream");
assert.equal(session.health.state, "live");
const reconnected = session.reconnect(factsAt);
assert.equal(reconnected.ok, true);
assert.equal(reconnected.health.state, "live");
assert.equal(reconnected.health.reconnectCount, 1);
assert.equal(reconnected.health.publicBroadcast, false);
session.reconnect(factsAt);
session.reconnect(factsAt);
const exhausted = session.reconnect(factsAt);
assert.equal(exhausted.ok, false);
assert.equal(exhausted.health.state, "failed");
assert.equal(exhausted.health.errorCode, "reconnect_budget_exhausted");

const platform = new ResidentSession();
const youtube = platform.start({ ...job, streamId: "yt-session", destination: "youtube" }, factsAt);
assert.equal(youtube.ok, false);
assert.equal(youtube.health.state, "failed");
assert.equal(youtube.health.publicBroadcast, false);
assert.equal(youtube.health.errorCode, "youtube_approval_required");
const tiktok = new ResidentSession().start({ ...job, streamId: "tt-session", destination: "tiktok" }, factsAt);
assert.equal(tiktok.health.errorCode, "tiktok_approval_required");
assert.equal(tiktok.health.state, "failed");

const unsafe = new ResidentSession().start({ ...job, streamKey: "secret" }, factsAt);
assert.equal(unsafe.errorCode, "credential_rejected");
const runtime = new ResidentSession();
runtime.start(job, factsAt);
const expired = runtime.expire(Date.parse(factsAt) + 601_000);
assert.equal(expired.state, "stopped");
assert.equal(expired.errorCode, "max_runtime_reached");

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function forceStop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
    return;
  }
  child.kill("SIGKILL");
}

function startWorker(stateDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "worker/ai-live-resident.mjs"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TRACER_AI_LIVE_STATE_DIR: stateDir,
      TRACER_AI_LIVE_ADMIN_TOKEN: adminToken,
      TRACER_AI_LIVE_ALLOW_UNVERIFIED_LOOPBACK: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  return { child, read: () => output };
}

async function waitFor(check, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(label);
}

async function request(port, path, body, options = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (body && options.auth !== false) headers.Authorization = `Bearer ${options.token || adminToken}`;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killWorkerOnly(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
    return;
  }
  child.kill("SIGKILL");
}

const dir = mkdtempSync(join(tmpdir(), "tracer-resident-"));
const first = startWorker(dir, { TRACER_AI_LIVE_MEDIA_HOLD: "1", TRACER_AI_LIVE_ALLOW_UNVERIFIED_LOOPBACK: "1" });
try {
  const ready = await waitFor(() => {
    const portFile = join(dir, "port.json");
    if (!existsSync(portFile)) return null;
    return JSON.parse(readFileSync(portFile, "utf8"));
  }, "worker did not listen");
  assert.equal(ready.host, "127.0.0.1");
  const health = await request(ready.port, "/health");
  assert.equal(health.body.state, "idle");
  assert.equal(health.body.publicBroadcast, false);
  const live = await request(ready.port, "/start", job);
  assert.equal(live.status, 200);
  assert.equal(live.body.health.state, "live");
  assert.equal(live.body.health.publicBroadcast, false);
  assert.equal(live.body.health.process, "running");
  const same = await request(ready.port, "/start", job);
  assert.equal(same.status, 200);
  assert.equal(same.body.idempotent, true);
  const other = await request(ready.port, "/start", { ...job, streamId: "other-session" });
  assert.equal(other.status, 409);
  assert.equal(other.body.errorCode, "duplicate_stream");
  assert.equal(other.body.health.state, "live");
  const again = await request(ready.port, "/reconnect", {});
  assert.equal(again.status, 200);
  assert.equal(again.body.health.reconnectCount, 1);
  assert.equal(again.body.health.state, "live");

  const duplicate = startWorker(dir);
  await waitFor(() => (hasExited(duplicate.child) ? true : null), "duplicate worker did not exit");
  assert.match(duplicate.read(), /duplicate_worker/);
  assert.doesNotMatch(duplicate.read(), /"ready":true/);
  assert.doesNotMatch(duplicate.read(), /rtmp:\/\//i);

  forceStop(first.child);
  await waitFor(() => (hasExited(first.child) ? true : null), "worker did not stop");
  rmSync(join(dir, "port.json"), { force: true });
  const recovered = startWorker(dir);
  try {
    const recoveredReady = await waitFor(() => {
      const portFile = join(dir, "port.json");
      if (!existsSync(portFile)) return null;
      return JSON.parse(readFileSync(portFile, "utf8"));
    }, "recovered worker did not listen");
    const after = await request(recoveredReady.port, "/health");
    assert.equal(after.body.state, "live");
    assert.equal(after.body.reconnectCount, 2);
    assert.equal(after.body.publicBroadcast, false);
    const stopped = await request(recoveredReady.port, "/stop", { streamId: "live-session-1", reason: "operator_requested" });
    assert.equal(stopped.body.health.state, "stopped");
    assert.equal(stopped.body.health.stopReason, "operator_requested");
    const shutdown = await request(recoveredReady.port, "/shutdown", {});
    assert.equal(shutdown.body.publicBroadcast, false);
    await waitFor(() => (hasExited(recovered.child) ? true : null), "shutdown did not exit");
    assert.equal(existsSync(join(dir, "worker.lock")), false);
    assert.doesNotMatch(recovered.read(), /worker-secret-slot/);
    assert.equal(recovered.read().includes(adminToken), false);
    assert.equal(readFileSync(join(dir, "state.json"), "utf8").includes(adminToken), false);
  } finally {
    if (recovered.child.exitCode === null) forceStop(recovered.child);
  }
} finally {
  if (first.child.exitCode === null) forceStop(first.child);
  rmSync(dir, { recursive: true, force: true });
}

const gains = residentMixGains();
assert.equal(gains.base, 0.35);
assert.equal(gains.duckRatio, 0.18);
assert.equal(SPEECH_DUCK_RATIO, 0.18);
assert.equal(gains.ducked, 0.35 * 0.18);
const mix = buildResidentFfmpegArgs({
  avatarVideo: "avatar.mp4",
  bgmPath: "bed.mp3",
  speechPath: "speech.mp3",
  outputPath: "introduction.mp4",
});
assert.equal(mix.ok, true);
assert.match(mix.args.join(" "), new RegExp(`volume=${gains.ducked.toFixed(4)}`));
assert.ok(mix.args.includes("-stream_loop"));
assert.equal(buildResidentFfmpegArgs({
  avatarVideo: "avatar.mp4",
  bgmPath: "bed.mp3",
  speechPath: "speech.mp3",
  outputPath: "rtmp://example/live",
}).ok, false);
const registeredVoice = "0839163163a84ce5b9919a1681ce156a";
assert.equal(isRegisteredResidentVoice(registeredVoice), true);
let fishCalls = 0;
const spoken = await synthesizeRegisteredVoice({
  voiceId: registeredVoice,
  text: "価格は12,800円です。",
  apiKey: "fish-key-must-stay-inside-the-request",
  fetchImpl: async () => {
    fishCalls += 1;
    return new Response(Buffer.alloc(1200, 1), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  },
});
assert.equal(spoken.ok, true);
assert.equal(fishCalls, 1);
let rejectedCalls = 0;
const rejectedVoice = await synthesizeRegisteredVoice({
  voiceId: "not-a-registered-voice",
  text: "読み上げません。",
  apiKey: "fish-key-must-stay-inside-the-request",
  fetchImpl: async () => {
    rejectedCalls += 1;
    return new Response(Buffer.alloc(1200, 1), { status: 200 });
  },
});
assert.equal(rejectedVoice.ok, false);
assert.equal(rejectedVoice.errorCode, "voice_not_registered");
assert.equal(rejectedCalls, 0);

const secretToken = "secret-manager-only-token";
const secretResource = "projects/tracer-live/secrets/ai-live-admin/versions/latest";
let secretHeader = "";
const loaded = await resolveWorkerAdminToken({
  TRACER_AI_LIVE_ADMIN_SECRET: secretResource,
  TRACER_AI_LIVE_SECRET_ACCESS_TOKEN: "metadata-access-token",
}, async (url, options) => {
  secretHeader = options?.headers?.Authorization || "";
  assert.equal(String(url).includes(secretToken), false);
  return new Response(JSON.stringify({ payload: { data: Buffer.from(secretToken).toString("base64") } }), { status: 200 });
});
assert.equal(tokensMatch(loaded, secretToken), true);
assert.equal(workerAuthSource({ TRACER_AI_LIVE_ADMIN_SECRET: secretResource }), "secret_manager");
assert.equal(JSON.stringify({ source: workerAuthSource({ TRACER_AI_LIVE_ADMIN_SECRET: secretResource }) }).includes(secretToken), false);
assert.equal(secretHeader.includes(secretToken), false);

const calls = [];
const unapproved = openDestinationSocket({
  destination: "youtube",
  env: { YOUTUBE_RTMP_URL: "rtmp://ingest.example/live", YOUTUBE_STREAM_KEY: "youtube-secret-key" },
  connectImpl: (host, port) => {
    calls.push({ host, port });
    return { destroy() {} };
  },
});
assert.equal(unapproved.opened, false);
assert.equal(calls.length, 0);
const tiktokClosed = openDestinationSocket({
  destination: "tiktok",
  env: { TRACER_AI_LIVE_TIKTOK_APPROVED: "approved" },
  connectImpl: () => {
    calls.push({ host: "tiktok", port: 0 });
    return { destroy() {} };
  },
});
assert.equal(tiktokClosed.opened, false);
assert.equal(calls.length, 0);
const approved = openDestinationSocket({
  destination: "youtube",
  env: {
    TRACER_AI_LIVE_YOUTUBE_APPROVED: "approved",
    YOUTUBE_RTMP_URL: "rtmp://ingest.example:1935/live/youtube-secret-key",
    YOUTUBE_STREAM_KEY: "youtube-secret-key",
  },
  connectImpl: (host, port) => {
    calls.push({ host, port });
    return { destroy() {} };
  },
});
assert.equal(approved.opened, true);
assert.deepEqual(calls, [{ host: "ingest.example", port: 1935 }]);
assert.equal(JSON.stringify(calls).includes("youtube-secret-key"), false);
approved.socket.destroy();

const stale = compareProductFacts({
  productId: "bag-1",
  sellingPrice: 12800,
  inventory: 2,
  supplierFingerprint: "a".repeat(32),
}, {
  id: "bag-1",
  sellingPrice: 12800,
  inventory: 2,
  inStock: true,
  updatedAt: "2020-01-01T00:00:00.000Z",
  supplierConfirmed: true,
  supplierFingerprint: "a".repeat(32),
}, Date.now());
assert.equal(stale.ok, false);
assert.equal(stale.errorCode, "stale_product_facts");

const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });
await waitFor(() => (pidAlive(holder.pid) ? true : null), "hold child did not start");
killProcessTree(holder.pid);
await waitFor(() => (pidAlive(holder.pid) ? null : true), "hold child was not killed");

const authDir = mkdtempSync(join(tmpdir(), "tracer-resident-auth-"));
const authWorker = startWorker(authDir);
try {
  const authReady = await waitFor(() => {
    const portFile = join(authDir, "port.json");
    if (!existsSync(portFile)) return null;
    return JSON.parse(readFileSync(portFile, "utf8"));
  }, "auth worker did not listen");
  const missing = await request(authReady.port, "/start", job, { auth: false });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.errorCode, "unauthorized");
  const wrong = await request(authReady.port, "/stop", { streamId: job.streamId }, { token: wrongToken });
  assert.equal(wrong.status, 401);
  const health = await request(authReady.port, "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.state, "idle");
  assert.equal(health.body.process, "running");
  assert.equal(health.body.productFacts.valid, null);
  assert.equal(health.body.destinationApproval.rtmpAllowed, false);
  const readyProbe = await request(authReady.port, "/ready");
  assert.equal(readyProbe.status, 200);
  assert.equal(readyProbe.body.ready, true);
  assert.equal(readyProbe.body.session.state, "idle");
  const leaked = JSON.stringify({ health: health.body, ready: readyProbe.body, wrong: wrong.body, output: authWorker.read(), state: readFileSync(join(authDir, "state.json"), "utf8") });
  assert.equal(leaked.includes(adminToken), false);
  assert.equal(leaked.includes(wrongToken), false);
  assert.equal(leaked.includes(secretToken), false);
  const shutdown = await request(authReady.port, "/shutdown", {});
  assert.equal(shutdown.status, 200);
  await waitFor(() => (hasExited(authWorker.child) ? true : null), "auth worker did not shut down");
} finally {
  if (authWorker.child.exitCode === null) forceStop(authWorker.child);
  rmSync(authDir, { recursive: true, force: true });
}

const failClosedDir = mkdtempSync(join(tmpdir(), "tracer-resident-fail-closed-"));
const failClosedWorker = startWorker(failClosedDir, { TRACER_AI_LIVE_ALLOW_UNVERIFIED_LOOPBACK: "0" });
try {
  const failClosedReady = await waitFor(() => {
    const portFile = join(failClosedDir, "port.json");
    if (!existsSync(portFile)) return null;
    return JSON.parse(readFileSync(portFile, "utf8"));
  }, "fail-closed worker did not listen");
  const blocked = await request(failClosedReady.port, "/start", { ...job, streamId: "missing-facts-session" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.errorCode, "inventory_unverified");
  assert.equal(blocked.body.health.state, "stopped");
  assert.equal(blocked.body.health.productFacts.valid, false);
  const notReady = await request(failClosedReady.port, "/ready");
  assert.equal(notReady.status, 503);
  await request(failClosedReady.port, "/shutdown", {});
  await waitFor(() => (hasExited(failClosedWorker.child) ? true : null), "fail-closed worker did not shut down");
} finally {
  if (failClosedWorker.child.exitCode === null) forceStop(failClosedWorker.child);
  rmSync(failClosedDir, { recursive: true, force: true });
}

const fingerprint = "b".repeat(32);
const freshProduct = {
  id: "bag-1",
  sellingPrice: 12800,
  inventory: 2,
  inStock: true,
  updatedAt: new Date().toISOString(),
  supplierConfirmed: true,
  supplierFingerprint: fingerprint,
};
const methods = [];
const factsServer = createServer((factsRequest, factsResponse) => {
  methods.push(factsRequest.method);
  const payload = JSON.stringify({
    ok: true,
    readOnly: true,
    products: factsRequest.url?.includes("stale")
      ? [{ ...freshProduct, updatedAt: "2020-01-01T00:00:00.000Z" }]
      : [freshProduct],
  });
  factsResponse.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  factsResponse.end(payload);
});
await new Promise((resolve) => factsServer.listen(0, "127.0.0.1", resolve));
const factsPort = factsServer.address().port;
const factJob = {
  ...job,
  streamId: "fact-session",
  segments: [{ ...job.segments[0], sellingPrice: 12800, inventory: 2, supplierFingerprint: fingerprint }],
};
const factDir = mkdtempSync(join(tmpdir(), "tracer-resident-facts-"));
const factWorker = startWorker(factDir, {
  TRACER_AI_LIVE_PRODUCTS_URL: `http://127.0.0.1:${factsPort}/products`,
  TRACER_AI_LIVE_PRODUCTS_TOKEN: productsToken,
  TRACER_AI_LIVE_MEDIA_HOLD: "1",
});
let factChildPid = 0;
try {
  const factReady = await waitFor(() => {
    const portFile = join(factDir, "port.json");
    if (!existsSync(portFile)) return null;
    return JSON.parse(readFileSync(portFile, "utf8"));
  }, "facts worker did not listen");
  const introduced = await request(factReady.port, "/start", factJob);
  assert.equal(introduced.status, 200);
  assert.equal(introduced.body.health.state, "live");
  assert.equal(introduced.body.health.productFacts.valid, true);
  assert.equal(introduced.body.health.destinationApproval.rtmpAllowed, false);
  const readyLive = await request(factReady.port, "/ready");
  assert.equal(readyLive.status, 200);
  assert.equal(readyLive.body.productFacts.valid, true);
  assert.deepEqual(methods, ["GET"]);
  factChildPid = introduced.body.health.childPids[0];
  assert.equal(pidAlive(factChildPid), true);
  const stopped = await request(factReady.port, "/stop", { streamId: factJob.streamId, reason: "operator_requested" });
  assert.equal(stopped.body.health.state, "stopped");
  await waitFor(() => (pidAlive(factChildPid) ? null : true), "stop did not kill the child");
  const staleServer = createServer((factsRequest, factsResponse) => {
    methods.push(factsRequest.method);
    const payload = JSON.stringify({
      ok: true,
      readOnly: true,
      products: [{ ...freshProduct, updatedAt: "2020-01-01T00:00:00.000Z", sellingPrice: 100 }],
    });
    factsResponse.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    factsResponse.end(payload);
  });
  await new Promise((resolve) => staleServer.listen(0, "127.0.0.1", resolve));
  const staleDir = mkdtempSync(join(tmpdir(), "tracer-resident-stale-"));
  const staleWorker = startWorker(staleDir, {
    TRACER_AI_LIVE_PRODUCTS_URL: `http://127.0.0.1:${staleServer.address().port}/products`,
    TRACER_AI_LIVE_PRODUCTS_TOKEN: productsToken,
    TRACER_AI_LIVE_MEDIA_HOLD: "1",
  });
  try {
    const staleReady = await waitFor(() => {
      const portFile = join(staleDir, "port.json");
      if (!existsSync(portFile)) return null;
      return JSON.parse(readFileSync(portFile, "utf8"));
    }, "stale worker did not listen");
    const expiredFacts = await request(staleReady.port, "/start", { ...factJob, streamId: "stale-session" });
    assert.equal(expiredFacts.status, 409);
    assert.equal(expiredFacts.body.errorCode, "stale_product_facts");
    assert.equal(expiredFacts.body.health.state, "stopped");
    assert.equal(expiredFacts.body.health.productFacts.valid, false);
    const staleReadyProbe = await request(staleReady.port, "/ready");
    assert.equal(staleReadyProbe.status, 503);
    assert.equal(staleReadyProbe.body.ready, false);
    const staleText = JSON.stringify({ body: expiredFacts.body, state: readFileSync(join(staleDir, "state.json"), "utf8"), output: staleWorker.read() });
    assert.equal(staleText.includes(productsToken), false);
    assert.equal(staleText.includes(adminToken), false);
    assert.equal(staleText.includes(fingerprint), false);
    await request(staleReady.port, "/shutdown", {});
    await waitFor(() => (hasExited(staleWorker.child) ? true : null), "stale worker did not shut down");
  } finally {
    if (staleWorker.child.exitCode === null) forceStop(staleWorker.child);
    staleServer.close();
    rmSync(staleDir, { recursive: true, force: true });
  }
  await request(factReady.port, "/shutdown", {});
  await waitFor(() => (hasExited(factWorker.child) ? true : null), "facts worker did not shut down");
} finally {
  if (factChildPid) killProcessTree(factChildPid);
  if (factWorker.child.exitCode === null) forceStop(factWorker.child);
  factsServer.close();
  rmSync(factDir, { recursive: true, force: true });
}

const runtimeDir = mkdtempSync(join(tmpdir(), "tracer-resident-runtime-"));
const runtimeWorker = startWorker(runtimeDir, { TRACER_AI_LIVE_MEDIA_HOLD: "1" });
let runtimePid = 0;
try {
  const runtimeReady = await waitFor(() => {
    const portFile = join(runtimeDir, "port.json");
    if (!existsSync(portFile)) return null;
    return JSON.parse(readFileSync(portFile, "utf8"));
  }, "runtime worker did not listen");
  const running = await request(runtimeReady.port, "/start", { ...job, streamId: "runtime-session", maxRuntimeSeconds: 30 });
  assert.equal(running.status, 200);
  runtimePid = running.body.health.childPids[0];
  assert.equal(pidAlive(runtimePid), true);
  killWorkerOnly(runtimeWorker.child);
  await waitFor(() => (hasExited(runtimeWorker.child) ? true : null), "runtime worker did not die");
  assert.equal(pidAlive(runtimePid), true);
  const saved = JSON.parse(readFileSync(join(runtimeDir, "state.json"), "utf8"));
  saved.startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(join(runtimeDir, "state.json"), JSON.stringify(saved));
  rmSync(join(runtimeDir, "port.json"), { force: true });
  const restarted = startWorker(runtimeDir, { TRACER_AI_LIVE_MEDIA_HOLD: "1" });
  try {
    const restartedReady = await waitFor(() => {
      const portFile = join(runtimeDir, "port.json");
      if (!existsSync(portFile)) return null;
      return JSON.parse(readFileSync(portFile, "utf8"));
    }, "restarted runtime worker did not listen");
    const afterRuntime = await request(restartedReady.port, "/health");
    assert.equal(afterRuntime.body.state, "stopped");
    assert.equal(afterRuntime.body.errorCode, "max_runtime_reached");
    assert.equal(afterRuntime.body.publicBroadcast, false);
    await waitFor(() => (pidAlive(runtimePid) ? null : true), "max runtime did not kill the child");
    const runtimeText = JSON.stringify({ health: afterRuntime.body, state: readFileSync(join(runtimeDir, "state.json"), "utf8"), output: restarted.read() });
    assert.equal(runtimeText.includes(adminToken), false);
    assert.doesNotMatch(runtimeText, /rtmp:\/\//i);
    await request(restartedReady.port, "/shutdown", {});
    await waitFor(() => (hasExited(restarted.child) ? true : null), "restarted runtime worker did not shut down");
  } finally {
    if (restarted.child.exitCode === null) forceStop(restarted.child);
  }
} finally {
  if (runtimePid) killProcessTree(runtimePid);
  if (runtimeWorker.child.exitCode === null) forceStop(runtimeWorker.child);
  rmSync(runtimeDir, { recursive: true, force: true });
}

const source = readFileSync(new URL("../worker/ai-live-resident.mjs", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../worker/Dockerfile", import.meta.url), "utf8");
const deployDoc = readFileSync(new URL("../docs/ai-live-resident-deploy.md", import.meta.url), "utf8");
assert.match(source, /127\.0\.0\.1/);
assert.match(source, /openSync\(lockPath, "wx"/);
assert.match(source, /renameSync\(temporaryPath, statePath\)/);
assert.match(source, /TRACER_AI_LIVE_ALLOW_UNVERIFIED_LOOPBACK/);
assert.match(source, /\/ready/);
assert.match(source, /openDestinationSocket/);
assert.match(source, /haltChildren/);
assert.doesNotMatch(source, /console\.log\(process\.env/);
assert.doesNotMatch(source, /rtmp:\/\//i);
assert.match(dockerfile, /ffmpeg/);
assert.match(dockerfile, /Vercel Function/);
assert.match(deployDoc, /Vercel Functions/);
assert.match(deployDoc, /FFmpeg/);
assert.match(deployDoc, /0\.18/);
console.log("AI live resident worker start, stop, and reconnect checks passed");
