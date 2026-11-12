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
if (session.health.state === "live" || session.health.state === "reconnecting") {
  session.reconnect(new Date().toISOString());
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
  if (errorCode === "inventory_unverified") return "inventory_unverified";
  if (errorCode === "speech_provider_failed" || errorCode === "media_spawn_failed" || errorCode === "media_exited" || errorCode === "media_unavailable" || errorCode === "media_output_not_started") {
    return "speech_provider_failed";
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
  const sessionReady = health.state === "idle"
    || (health.state === "live" && health.destination === "loopback" && health.productFacts.valid === true);
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

async function reverifyLive(nowMs) {
  if (session.health.state !== "live" && session.health.state !== "reconnecting") return { ok: true };
  const expectations = session.health.factExpectations;
  if (!expectations.length) {
    stopForFacts("product_facts_unconfigured");
    return { ok: false, errorCode: "product_facts_unconfigured" };
  }
  const verified = await verifyExpectations(expectations, nowMs);
  if (!verified.ok) {
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

function watchMedia(child, outputPath) {
  mediaChildren.add(child);
  if (child.pid) session.trackChild(child.pid);
  let sawOutput = false;
  const noteOutput = () => {
    if (sawOutput || !outputHasStarted(outputPath)) return;
    sawOutput = true;
    if (session.health.state === "live" || session.health.state === "reconnecting") session.setMediaReady(true);
    persist();
  };
  child.stderr?.on("data", () => noteOutput());
  child.stdout?.on("data", () => noteOutput());
  const poll = setInterval(noteOutput, 50);
  child.once("error", () => {
    clearInterval(poll);
    mediaChildren.delete(child);
    failForMedia("media_spawn_failed");
  });
  child.once("exit", (code, signal) => {
    clearInterval(poll);
    mediaChildren.delete(child);
    if (session.health.state !== "live" && session.health.state !== "reconnecting" && session.health.state !== "starting") return;
    if (code !== 0 || signal || !outputHasStarted(outputPath)) failForMedia("media_exited");
  });
  return noteOutput;
}

function spawnHoldChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  child.unref();
  mediaChildren.add(child);
  if (child.pid) session.trackChild(child.pid);
  child.once("exit", () => mediaChildren.delete(child));
}

async function waitForMediaStart(child, noteOutput, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(ready);
    };
    const poll = setInterval(() => {
      noteOutput();
      if (session.health.mediaReady) finish(true);
      else if (session.health.state === "failed") finish(false);
    }, 40);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("error", () => finish(false));
    child.once("exit", () => finish(session.health.mediaReady === true));
  });
}

async function startMedia(job) {
  if (session.health.productFacts.valid !== true) return { ok: false, errorCode: "product_facts_unconfigured" };
  if (process.env.TRACER_AI_LIVE_MEDIA_HOLD === "1") {
    spawnHoldChild();
    return { ok: true, attempted: false };
  }
  const segment = job.segments?.[0];
  const voiceId = segment?.voiceId;
  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim() || "";
  let speechPath = process.env.TRACER_AI_LIVE_SPEECH_PATH?.trim() || "";
  if (voiceId) {
    if (!apiKey || !segment?.scriptText || !isRegisteredResidentVoice(voiceId)) {
      return { ok: false, errorCode: "speech_provider_failed" };
    }
    const spoken = await synthesizeRegisteredVoice({ voiceId, text: segment.scriptText, apiKey });
    if (!spoken.ok) return { ok: false, errorCode: "speech_provider_failed" };
    speechPath = join(stateDir, "speech.mp3");
    writeFileSync(speechPath, spoken.bytes);
  }
  const avatarVideo = process.env.TRACER_AI_LIVE_AVATAR_VIDEO?.trim() || "";
  const bgmPath = process.env.TRACER_AI_LIVE_BGM_PATH?.trim() || "";
  if (!avatarVideo || !bgmPath || !speechPath) return { ok: false, errorCode: "media_unavailable" };
  if (![avatarVideo, bgmPath, speechPath].every((path) => existsSync(path))) {
    return { ok: false, errorCode: "media_unavailable" };
  }
  const outputPath = join(stateDir, "introduction.mp4");
  const plan = buildResidentFfmpegArgs({ avatarVideo, bgmPath, speechPath, outputPath });
  if (!plan.ok) return { ok: false, errorCode: "media_spawn_failed" };
  const script = process.env.TRACER_AI_LIVE_FFMPEG_SCRIPT?.trim() || "";
  const command = script ? process.execPath : (process.env.TRACER_AI_LIVE_FFMPEG_BIN?.trim() || "ffmpeg");
  const args = script ? [script, ...plan.args] : plan.args;
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const noteOutput = watchMedia(child, outputPath);
  const ready = await waitForMediaStart(child, noteOutput);
  if (!ready || session.health.mediaReady !== true) {
    if (session.health.state !== "failed") failForMedia("media_output_not_started");
    return { ok: false, errorCode: session.health.errorCode || "media_output_not_started" };
  }
  return { ok: true, attempted: true };
}

await reverifyLive(Date.now());
applyRuntimeLimit(Date.now());
if ((session.health.state === "live" || session.health.state === "reconnecting") && process.env.TRACER_AI_LIVE_MEDIA_HOLD === "1") {
  haltChildren();
  spawnHoldChild();
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
      await reverifyLive(Date.now());
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
      if (body?.destination === "youtube" || body?.destination === "tiktok") {
        const gate = openDestinationSocket({ destination: body.destination, env: process.env });
        if (gate.opened) {
          rejectStart(response, "destination_adapter_not_implemented");
          return;
        }
      }
      if (!process.env.TRACER_AI_LIVE_PRODUCTS_URL?.trim()) {
        rejectStart(response, "product_facts_unconfigured");
        return;
      }
      const result = session.start(body, now);
      if (!(result.ok && result.health.state === "live")) {
        persist();
        send(response, result.ok ? 200 : 409, {
          ok: result.ok,
          ...(result.ok ? {} : { errorCode: result.errorCode }),
          ...(result.idempotent ? { idempotent: true } : {}),
          publicBroadcast: false,
          health: view(session.snapshot()),
        });
        return;
      }
      if (result.idempotent) {
        const again = await reverifyLive(Date.parse(now));
        persist();
        send(response, again.ok && session.health.state === "live" ? 200 : 409, {
          ok: again.ok && session.health.state === "live",
          idempotent: true,
          ...(again.ok ? {} : { errorCode: again.errorCode || session.health.errorCode }),
          publicBroadcast: false,
          health: view(session.snapshot()),
        });
        return;
      }
      const parsed = expectationsFrom(body.segments);
      if (!parsed.ok) {
        stopForFacts(parsed.errorCode);
        rejectStart(response, parsed.errorCode);
        return;
      }
      const verified = await verifyExpectations(parsed.expectations, Date.parse(now));
      if (!verified.ok) {
        stopForFacts(verified.errorCode);
        rejectStart(response, verified.errorCode);
        return;
      }
      session.setFactExpectations(parsed.expectations);
      session.setProductFacts({ valid: true, reason: null });
      const media = await startMedia(body);
      if (!media.ok) {
        failForMedia(media.errorCode);
        rejectStart(response, media.errorCode);
        return;
      }
      persist();
      send(response, 200, { ok: true, publicBroadcast: false, health: view(session.snapshot()) });
      return;
    }
    let result;
    if (url.pathname === "/stop") {
      result = session.stop(String(body.streamId || ""), String(body.reason || "operator_requested"), now);
      if (result.ok) haltChildren();
    } else if (url.pathname === "/reconnect") {
      result = session.reconnect(now);
      if (result.ok) await reverifyLive(Date.parse(now));
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
  reverifyLive(Date.now()).finally(() => persist());
}, 5_000).unref();
