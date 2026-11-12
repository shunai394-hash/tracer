import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ResidentSession } from "../lib/ai-live/resident-worker.ts";

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

function forceStop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
    return;
  }
  child.kill("SIGKILL");
}

function startWorker(stateDir) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "worker/ai-live-resident.mjs"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TRACER_AI_LIVE_STATE_DIR: stateDir,
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

async function request(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const dir = mkdtempSync(join(tmpdir(), "tracer-resident-"));
const first = startWorker(dir);
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
  const again = await request(ready.port, "/reconnect", {});
  assert.equal(again.status, 200);
  assert.equal(again.body.health.reconnectCount, 1);
  assert.equal(again.body.health.state, "live");

  const duplicate = startWorker(dir);
  const duplicateExit = await waitFor(() => (duplicate.child.exitCode === null ? null : duplicate.child.exitCode), "duplicate worker did not exit");
  assert.equal(duplicateExit, 2);
  assert.match(duplicate.read(), /duplicate_worker/);
  assert.doesNotMatch(duplicate.read(), /rtmp:\/\//i);

  forceStop(first.child);
  await waitFor(() => (first.child.exitCode === null ? null : true), "worker did not stop");
  const recovered = startWorker(dir);
  try {
    const recoveredReady = await waitFor(() => {
      const text = recovered.read();
      if (!text.includes("\"ready\":true")) return null;
      return JSON.parse(readFileSync(join(dir, "port.json"), "utf8"));
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
    await waitFor(() => (recovered.child.exitCode === null ? null : true), "shutdown did not exit");
    assert.equal(existsSync(join(dir, "worker.lock")), false);
    assert.doesNotMatch(recovered.read(), /worker-secret-slot/);
  } finally {
    if (recovered.child.exitCode === null) forceStop(recovered.child);
  }
} finally {
  if (first.child.exitCode === null) forceStop(first.child);
  rmSync(dir, { recursive: true, force: true });
}

const source = readFileSync(new URL("../worker/ai-live-resident.mjs", import.meta.url), "utf8");
assert.match(source, /127\.0\.0\.1/);
assert.doesNotMatch(source, /console\.log\(process\.env/);
assert.doesNotMatch(source, /rtmp:\/\//i);
console.log("AI live resident worker start, stop, and reconnect checks passed");
