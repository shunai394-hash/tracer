/**
 * Long-running AI live worker. Bind is loopback only.
 * Product facts must be read from TRACER before a session can start.
 * YouTube and TikTok do not open sockets in this revision, even when an
 * approval flag and a secret are both present. The process does not print secrets.
 * Do not run this file inside a Vercel Function.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { destinationApprovalView, openDestinationSocket } from "../lib/ai-live/destination-gate.ts";
import { compareProductFacts } from "../lib/ai-live/product-facts-check.ts";
import { readBearer, resolveWorkerAdminToken, tokensMatch } from "../lib/ai-live/resident-auth.ts";
import {
  buildResidentFfmpegArgs,
  isRegisteredResidentVoice,
  synthesizeRegisteredVoice,
} from "../lib/ai-live/resident-media.ts";
import { killProcessTree } from "../lib/ai-live/resident-process.ts";
import { ResidentSession } from "../lib/ai-live/resident-worker.ts";

const stateDir = process.env.TRACER_AI_LIVE_STATE_DIR || "";
if (!stateDir) {
  console.log(JSON.stringify({ ok: false, errorCode: "state_dir_required", publicBroadcast: false }));
  process.exit(1);
}
mkdirSync(stateDir, { recursive: true });

const lockPath = join(stateDir, "worker.lock");
const statePath = join(stateDir, "state.json");
const portPath = join(stateDir, "port.json");
const adminToken = await resolveWorkerAdminToken(process.env);
const mediaChildren = new Set();

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function duplicateWorkerExit() {
  writeSync(1, JSON.stringify({ ok: false, errorCode: "duplicate_worker", publicBroadcast: false }) + "\n");
  process.exit(2);
}

function createExclusiveLock() {
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      stale = !pidAlive(lock.pid);
    } catch {
      stale = true;
    }
    if (!stale) duplicateWorkerExit();
    const stalePath = `${lockPath}.stale-${process.pid}`;
    try {
      renameSync(lockPath, stalePath);
      rmSync(stalePath, { force: true });
    } catch (renameError) {
      if (renameError?.code !== "ENOENT") {
        try {
          fd = openSync(lockPath, "wx", 0o600);
        } catch (retryError) {
          if (retryError?.code === "EEXIST") duplicateWorkerExit();
          throw retryError;
        }
      }
    }
    if (fd === undefined) {
      try {
        fd = openSync(lockPath, "wx", 0o600);
      } catch (retryError) {
        if (retryError?.code === "EEXIST") duplicateWorkerExit();
        throw retryError;
      }
    }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
}

createExclusiveLock();

const session = new ResidentSession();
try {
  if (existsSync(statePath)) session.restore(JSON.parse(readFileSync(statePath, "utf8")));
} catch {
  session.restore(null);
}
if (session.health.state === "live" || session.health.state === "reconnecting" || session.health.state === "starting") {
  const started = Date.parse(session.health.startedAt || "");
  const limit = session.health.maxRuntimeSeconds ?? 0;
  const expired = Number.isFinite(started) && limit >= 30 && Date.now() >= started + limit * 1000;
  for (const pid of session.clearChildren()) killProcessTree(pid);
  const streamId = session.health.streamId;
  if (streamId) {
    const errorCode = expired ? "max_runtime_reached" : "worker_restarted";
    const reason = expired ? "worker_shutdown" : "worker_restarted";
    session.stop(streamId, reason, new Date().toISOString(), errorCode);
  }
}

function persist() {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(session.snapshot()), { mode: 0o600 });
    renameSync(temporaryPath, statePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

let haltingChildren = false;
function haltChildren() {
  if (haltingChildren) return;
  haltingChildren = true;
  try {
    for (const child of mediaChildren) {
      if (child.pid) killProcessTree(child.pid);
    }
    mediaChildren.clear();
    for (const pid of session.clearChildren()) killProcessTree(pid);
    session.setMediaReady(false);
  } finally {
    haltingChildren = false;
  }
}

function stopReasonFor(errorCode) {
  if (errorCode === "inventory_unverified" || errorCode === "speech_provider_failed" || String(errorCode).startsWith("media_")) {
    return errorCode;
  }
  return "stale_product_facts";
}

function stopForFacts(errorCode) {
  const streamId = session.health.streamId;
  session.setProductFacts({ valid: false, reason: errorCode });
  session.setMediaReady(false);
  haltChildren();
  if (streamId && (session.health.state === "live" || session.health.state === "reconnecting" || session.health.state === "starting")) {
    session.stop(streamId, stopReasonFor(errorCode), new Date().toISOString(), errorCode);
  }
  persist();
}

function failForMedia(errorCode) {
  const streamId = session.health.streamId;
  session.setMediaReady(false);
  haltChildren();
  if (streamId && session.health.state !== "failed" && session.health.state !== "stopped" && session.health.state !== "idle") {
    session.fail(streamId, stopReasonFor(errorCode), new Date().toISOString(), errorCode);
  }
  persist();
}

function applyRuntimeLimit(nowMs) {
  const before = session.health.errorCode;
  session.expire(nowMs);
  if (session.health.errorCode === "max_runtime_reached" && before !== "max_runtime_reached") {
    haltChildren();
  }
}

function view(health) {
  const approval = destinationApprovalView(health.destination, process.env);
  const gate = health.destination === "youtube" || health.destination === "tiktok"
    ? openDestinationSocket({ destination: health.destination, env: process.env })
    : { opened: false, reason: health.destination === "loopback" ? "loopback_has_no_rtmp" : null };
  return {
    ...health,
    publicBroadcast: false,
    mediaReady: health.mediaReady === true,
    destinationApproval: {
      ...approval,
      rtmpAllowed: false,
      socketOpened: false,
      connectReason: gate.reason,
    },
  };
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(Object.assign(new Error("body_too_large"), { code: "body_too_large" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function requireControl(request, response) {
  if (!adminToken) {
    request.resume();
    send(response, 503, { ok: false, errorCode: "admin_auth_unavailable", publicBroadcast: false });
    return false;
  }
  if (!tokensMatch(adminToken, readBearer(request.headers.authorization))) {
    request.resume();
    send(response, 401, { ok: false, errorCode: "unauthorized", publicBroadcast: false });
    return false;
  }
  return true;
}

function readyDecision(health) {
  const liveReady = health.state === "live"
    && health.destination === "loopback"
    && health.productFacts.valid === true
    && health.mediaReady === true;
  const sessionReady = !startLock && (health.state === "idle" || liveReady);
  return {
    ready: health.process === "running" && sessionReady,
    process: health.process,
    session: { state: health.state, streamId: health.streamId },
    productFacts: { valid: health.productFacts.valid, reason: health.productFacts.reason },
    destinationApproval: view(health).destinationApproval,
    mediaReady: health.mediaReady === true,
    publicBroadcast: false,
  };
}

function productsTimeoutMs() {
  const requested = Number(process.env.TRACER_AI_LIVE_PRODUCTS_TIMEOUT_MS || 8000);
  if (!Number.isFinite(requested)) return 8000;
  return Math.min(8000, Math.max(50, Math.floor(requested)));
}

async function loadSellableProducts() {
  const url = process.env.TRACER_AI_LIVE_PRODUCTS_URL?.trim() || "";
  if (!url) return { ok: false, errorCode: "product_facts_unconfigured" };
  const headers = { Accept: "application/json" };
  const productsToken = process.env.TRACER_AI_LIVE_PRODUCTS_TOKEN?.trim();
  if (productsToken) headers.Authorization = `Bearer ${productsToken}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(productsTimeoutMs()),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, errorCode: "product_facts_unauthorized" };
    if (!response.ok) return { ok: false, errorCode: "product_facts_unavailable" };
    const body = await response.json();
    if (!body || body.readOnly !== true || !Array.isArray(body.products)) {
      return { ok: false, errorCode: "product_facts_unavailable" };
    }
    return { ok: true, products: body.products };
  } catch {
    return { ok: false, errorCode: "product_facts_unavailable" };
  }
}

function factFromProduct(product) {
  if (!product || typeof product !== "object") return null;
  return {
    id: String(product.id || ""),
    sellingPrice: Number(product.sellingPrice),
    inventory: Number(product.inventory),
    inStock: product.inStock === true,
    updatedAt: typeof product.updatedAt === "string" ? product.updatedAt : "",
    supplierConfirmed: product.supplierConfirmed === true,
    supplierFingerprint: typeof product.supplierFingerprint === "string" ? product.supplierFingerprint : null,
  };
}

function expectationsFrom(segments) {
  const expectations = [];
  for (const segment of segments || []) {
    if (typeof segment?.sellingPrice !== "number" || !Number.isInteger(segment?.inventory) || typeof segment?.supplierFingerprint !== "string") {
      return { ok: false, errorCode: "stale_product_facts" };
    }
    if (segment.voiceId && !isRegisteredResidentVoice(segment.voiceId)) {
      return { ok: false, errorCode: "speech_provider_failed" };
    }
    expectations.push({
      productId: segment.productId,
      sellingPrice: segment.sellingPrice,
      inventory: segment.inventory,
      supplierFingerprint: segment.supplierFingerprint,
    });
  }
  if (!expectations.length) return { ok: false, errorCode: "stale_product_facts" };
  return { ok: true, expectations };
}

async function verifyExpectations(expectations, nowMs) {
  const catalog = await loadSellableProducts();
  if (!catalog.ok) return catalog;
  for (const expected of expectations) {
    const actual = catalog.products.map(factFromProduct).find((item) => item && item.id === expected.productId) || null;
    const compared = compareProductFacts(expected, actual, nowMs);
    if (!compared.ok) return compared;
  }
  return { ok: true };
}

let startLock = false;
let factEpoch = 0;
let reverifyTail = Promise.resolve();

function queueReverify(nowMs) {
  const run = reverifyTail.then(() => reverifyOnce(nowMs));
  reverifyTail = run.then(() => undefined, () => undefined);
  return run;
}

async function reverifyOnce(nowMs, options = {}) {
  if (startLock && options.duringStart !== true) return { ok: true, deferred: true };
  if (session.health.state !== "live" && session.health.state !== "reconnecting") return { ok: true };
  const epoch = factEpoch;
  const streamId = session.health.streamId;
  const expectations = session.health.factExpectations.map((item) => ({ ...item }));
  if (!expectations.length) {
    factEpoch += 1;
    stopForFacts("product_facts_unconfigured");
    return { ok: false, errorCode: "product_facts_unconfigured" };
  }
  const verified = await verifyExpectations(expectations, nowMs);
  if ((startLock && options.duringStart !== true) || factEpoch !== epoch || session.health.streamId !== streamId) return { ok: false, stale: true };
  if (session.health.state !== "live" && session.health.state !== "reconnecting") return { ok: false, stale: true };
  if (JSON.stringify(session.health.factExpectations) !== JSON.stringify(expectations)) return { ok: false, stale: true };
  if (!verified.ok) {
    factEpoch += 1;
    stopForFacts(verified.errorCode);
    return verified;
  }
  session.setProductFacts({ valid: true, reason: null });
  return { ok: true };
}

function outputHasStarted(outputPath) {
  try {
    return existsSync(outputPath) && statSync(outputPath).size > 0;
  } catch {
    return false;
  }
}

function mediaProcessRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null && pidAlive(child.pid);
}

function watchMedia(child, outputPath) {
  mediaChildren.add(child);
  if (child.pid) session.trackChild(child.pid);
  const noteOutput = () => {
    const running = mediaProcessRunning(child);
    const producing = running && outputHasStarted(outputPath);
    const active = session.health.state === "live" || session.health.state === "reconnecting" || session.health.state === "starting";
    if (producing && active) {
      session.setMediaReady(true);
      persist();
      return true;
    }
    if (!running && active && (child.exitCode !== null || child.signalCode || !pidAlive(child.pid))) {
      session.setMediaReady(false);
    }
    return false;
  };
  child.once("error", () => {
    mediaChildren.delete(child);
    failForMedia("media_spawn_failed");
  });
  child.once("exit", (code, signal) => {
    mediaChildren.delete(child);
    if (session.health.state !== "live" && session.health.state !== "reconnecting" && session.health.state !== "starting") return;
    if (code !== 0 || signal || !outputHasStarted(outputPath) || !pidAlive(child.pid)) failForMedia("media_exited");
  });
  return noteOutput;
}

function mediaStartTimeoutMs() {
  const requested = Number(process.env.TRACER_AI_LIVE_MEDIA_START_TIMEOUT_MS || 500);
  if (!Number.isFinite(requested)) return 500;
  return Math.min(5000, Math.max(50, Math.floor(requested)));
}

async function waitForMediaStart(child, noteOutput) {
  const timeoutMs = mediaStartTimeoutMs();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(ready === true);
    };
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
    const poll = setInterval(() => {
      if (session.health.state === "failed" || session.health.state === "stopped") finish(false);
      else if (noteOutput() && mediaProcessRunning(child)) finish(true);
    }, 40);
    setTimeout(() => finish(session.health.mediaReady === true && mediaProcessRunning(child)), timeoutMs);
  });
}

function mediaConfiguration(job) {
  const segment = job?.segments?.[0];
  const voiceId = typeof segment?.voiceId === "string" ? segment.voiceId : "";
  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim() || "";
  const speechPath = process.env.TRACER_AI_LIVE_SPEECH_PATH?.trim() || "";
  const avatarVideo = process.env.TRACER_AI_LIVE_AVATAR_VIDEO?.trim() || "";
  const bgmPath = process.env.TRACER_AI_LIVE_BGM_PATH?.trim() || "";
  if (voiceId) {
    if (!apiKey || !segment?.scriptText || !isRegisteredResidentVoice(voiceId)) {
      return { ok: false, errorCode: "speech_provider_failed" };
    }
  } else if (!speechPath || !existsSync(speechPath)) {
    return { ok: false, errorCode: "media_unavailable" };
  }
  if (!avatarVideo || !existsSync(avatarVideo) || !bgmPath || !existsSync(bgmPath)) {
    return { ok: false, errorCode: "media_unavailable" };
  }
  return { ok: true };
}

async function startMedia(job) {
  if (session.health.productFacts.valid !== true || session.health.state !== "starting") {
    return { ok: false, errorCode: "product_facts_unconfigured" };
  }
  const configured = mediaConfiguration(job);
  if (!configured.ok) return configured;
  const segment = job.segments?.[0];
  const voiceId = segment?.voiceId;
  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim() || "";
  let speechPath = process.env.TRACER_AI_LIVE_SPEECH_PATH?.trim() || "";
  if (voiceId) {
    const spoken = await synthesizeRegisteredVoice({ voiceId, text: segment.scriptText, apiKey });
    if (!spoken.ok) return { ok: false, errorCode: "speech_provider_failed" };
    speechPath = join(stateDir, "speech.mp3");
    writeFileSync(speechPath, spoken.bytes);
  }
  const avatarVideo = process.env.TRACER_AI_LIVE_AVATAR_VIDEO.trim();
  const bgmPath = process.env.TRACER_AI_LIVE_BGM_PATH.trim();
  const outputPath = join(stateDir, "introduction.mp4");
  const plan = buildResidentFfmpegArgs({ avatarVideo, bgmPath, speechPath, outputPath });
  if (!plan.ok) return { ok: false, errorCode: "media_spawn_failed" };
  const script = process.env.TRACER_AI_LIVE_FFMPEG_SCRIPT?.trim() || "";
  const command = script ? process.execPath : (process.env.TRACER_AI_LIVE_FFMPEG_BIN?.trim() || "ffmpeg");
  const args = script ? [script, ...plan.args] : plan.args;
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true, detached: true });
  const noteOutput = watchMedia(child, outputPath);
  const ready = await waitForMediaStart(child, noteOutput);
  if (!ready || !mediaProcessRunning(child) || session.health.mediaReady !== true) {
    const errorCode = session.health.state === "failed"
      ? (session.health.errorCode || "media_spawn_failed")
      : "media_start_timeout";
    failForMedia(errorCode);
    return { ok: false, errorCode };
  }
  return { ok: true };
}

await queueReverify(Date.now());
applyRuntimeLimit(Date.now());
if (session.health.state === "live" || session.health.state === "reconnecting") {
  const restoredPid = session.health.childPids.find((pid) => pidAlive(pid));
  const restoredOutput = outputHasStarted(join(stateDir, "introduction.mp4"));
  session.setMediaReady(Boolean(restoredPid) && restoredOutput);
}
persist();

let closing = false;
function shutdown(reason) {
  if (closing) return;
  closing = true;
  haltChildren();
  if (session.health.state === "live" || session.health.state === "starting" || session.health.state === "reconnecting") {
    session.stop(session.health.streamId, reason, new Date().toISOString());
  }
  persist();
  rmSync(lockPath, { force: true });
  rmSync(portPath, { force: true });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

function rejectStart(response, errorCode) {
  persist();
  send(response, 409, {
    ok: false,
    errorCode,
    publicBroadcast: false,
    health: view(session.snapshot()),
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/ready")) {
      applyRuntimeLimit(Date.now());
      await queueReverify(Date.now());
      persist();
      const health = view(session.snapshot());
      if (url.pathname === "/health") {
        send(response, 200, health);
        return;
      }
      const decision = readyDecision(session.snapshot());
      send(response, decision.ready ? 200 : 503, decision);
      return;
    }
    if (request.method !== "POST") {
      send(response, 404, { ok: false, errorCode: "not_found", publicBroadcast: false });
      return;
    }
    if (!requireControl(request, response)) return;
    const raw = await readBody(request);
    const body = raw ? JSON.parse(raw) : {};
    const now = new Date().toISOString();
    if (url.pathname === "/start") {
      if (startLock || session.health.state === "starting") {
        rejectStart(response, "start_in_progress");
        return;
      }
      startLock = true;
      factEpoch += 1;
      try {
        if (body?.destination === "youtube" || body?.destination === "tiktok") {
          const gate = openDestinationSocket({ destination: body.destination, env: process.env });
          if (gate.opened) {
            rejectStart(response, "destination_adapter_not_implemented");
            return;
          }
          const rejectedDestination = session.start(body, now);
          persist();
          send(response, 409, {
            ok: false,
            errorCode: rejectedDestination.errorCode || "destination_not_ready",
            publicBroadcast: false,
            health: view(session.snapshot()),
          });
          return;
        }
        if (!process.env.TRACER_AI_LIVE_PRODUCTS_URL?.trim()) {
          rejectStart(response, "product_facts_unconfigured");
          return;
        }
        if ((session.health.state === "live" || session.health.state === "reconnecting") && session.health.streamId === body?.streamId) {
          const again = await reverifyOnce(Date.parse(now), { duringStart: true });
          const stillLive = again.ok === true && session.health.state === "live" && session.health.mediaReady === true;
          persist();
          send(response, stillLive ? 200 : 409, {
            ok: stillLive,
            idempotent: true,
            ...(stillLive ? {} : { errorCode: again.errorCode || session.health.errorCode }),
            publicBroadcast: false,
            health: view(session.snapshot()),
          });
          return;
        }
        if (session.health.state === "live" || session.health.state === "reconnecting") {
          persist();
          send(response, 409, {
            ok: false,
            errorCode: "duplicate_stream",
            publicBroadcast: false,
            health: view(session.snapshot()),
          });
          return;
        }
        const parsed = expectationsFrom(body?.segments);
        if (!parsed.ok) {
          session.recordRejection(body, now, parsed.errorCode);
          rejectStart(response, parsed.errorCode);
          return;
        }
        const verified = await verifyExpectations(parsed.expectations, Date.parse(now));
        if (session.health.state === "live") {
          rejectStart(response, "start_in_progress");
          return;
        }
        if (!verified.ok) {
          session.recordRejection(body, now, verified.errorCode);
          rejectStart(response, verified.errorCode);
          return;
        }
        const begun = session.beginStart(body, now, parsed.expectations);
        if (!begun.ok || session.health.state !== "starting") {
          persist();
          send(response, 409, {
            ok: false,
            errorCode: begun.errorCode || "not_starting",
            publicBroadcast: false,
            health: view(session.snapshot()),
          });
          return;
        }
        const configured = mediaConfiguration(body);
        if (!configured.ok) {
          failForMedia(configured.errorCode);
          rejectStart(response, configured.errorCode);
          return;
        }
        persist();
        const media = await startMedia(body);
        if (!media.ok || session.health.mediaReady !== true || session.health.state === "failed") {
          if (session.health.state === "starting") failForMedia(media.errorCode || "media_start_timeout");
          rejectStart(response, session.health.errorCode || media.errorCode || "media_start_timeout");
          return;
        }
        const committed = session.commitLive(now);
        if (!committed.ok || session.health.state !== "live") {
          if (session.health.state === "starting") failForMedia(committed.errorCode || "media_not_ready");
          rejectStart(response, committed.errorCode || "media_not_ready");
          return;
        }
        persist();
        send(response, 200, { ok: true, publicBroadcast: false, health: view(session.snapshot()) });
      } finally {
        startLock = false;
      }
      return;
    }
    let result;
    if (url.pathname === "/stop") {
      result = session.stop(String(body.streamId || ""), String(body.reason || "operator_requested"), now);
      if (result.ok) haltChildren();
    } else if (url.pathname === "/reconnect") {
      result = session.reconnect(now);
      if (result.ok) await queueReverify(Date.parse(now));
    } else if (url.pathname === "/shutdown") {
      send(response, 200, { ok: true, publicBroadcast: false, state: "stopped" });
      shutdown("worker_shutdown");
      return;
    } else {
      send(response, 404, { ok: false, errorCode: "not_found", publicBroadcast: false });
      return;
    }
    persist();
    const stopAccepted = url.pathname === "/stop" && result.ok;
    const running = session.health.state === "live" || session.health.state === "reconnecting";
    const accepted = stopAccepted || (result.ok && running);
    send(response, accepted ? 200 : 409, {
      ok: accepted,
      ...(accepted ? {} : { errorCode: session.health.errorCode || result.errorCode }),
      ...(result.idempotent ? { idempotent: true } : {}),
      publicBroadcast: false,
      health: view(session.snapshot()),
    });
  } catch (error) {
    const code = error?.code === "body_too_large" ? "body_too_large" : "invalid_json";
    send(response, 400, { ok: false, errorCode: code, publicBroadcast: false });
  }
});

const requestedPort = Number(process.env.TRACER_AI_LIVE_PORT || 0);
const listenPort = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 0;
server.listen(listenPort, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(portPath, JSON.stringify({ port, host: "127.0.0.1" }));
  writeSync(1, JSON.stringify({ ok: true, ready: true, port, host: "127.0.0.1", publicBroadcast: false }) + "\n");
});

process.on("SIGTERM", () => shutdown("worker_shutdown"));
process.on("SIGINT", () => shutdown("worker_shutdown"));
setInterval(() => {
  applyRuntimeLimit(Date.now());
  queueReverify(Date.now()).finally(() => persist());
}, 5_000).unref();
