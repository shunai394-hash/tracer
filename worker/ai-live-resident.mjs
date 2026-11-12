/**
 * Long-running AI live worker. Bind is loopback only.
 * YouTube and TikTok are refused until that destination is officially approved
 * and a usable secret is present. The process does not print secrets.
 * Do not run this file inside a Vercel Function.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
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

function haltChildren() {
  for (const pid of session.clearChildren()) killProcessTree(pid);
}

function applyRuntimeLimit(nowMs) {
  const before = session.health.errorCode;
  session.expire(nowMs);
  if (session.health.errorCode === "max_runtime_reached" && before !== "max_runtime_reached") {
    haltChildren();
  }
}

applyRuntimeLimit(Date.now());
if ((session.health.state === "live" || session.health.state === "reconnecting") && process.env.TRACER_AI_LIVE_MEDIA_HOLD === "1") {
  haltChildren();
  spawnHoldChild();
}
persist();

function spawnHoldChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  child.unref();
  if (child.pid) session.trackChild(child.pid);
}

function spawnFfmpeg(args) {
  const child = spawn("ffmpeg", args, { stdio: "ignore", windowsHide: true });
  if (child.pid) session.trackChild(child.pid);
  return child;
}

function view(health) {
  return {
    ...health,
    destinationApproval: destinationApprovalView(health.destination, process.env),
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

function connectApproved(host, port) {
  const socket = net.connect({ host, port });
  socket.unref();
  return socket;
}

function readyDecision(health) {
  const approval = destinationApprovalView(health.destination, process.env);
  const sessionReady = health.state === "idle"
    || (health.state === "live" && health.destination === "loopback" && health.productFacts.valid === true);
  return {
    ready: health.process === "running" && sessionReady,
    process: health.process,
    session: { state: health.state, streamId: health.streamId },
    productFacts: { valid: health.productFacts.valid, reason: health.productFacts.reason },
    destinationApproval: approval,
  };
}

async function loadSellableProducts() {
  const url = process.env.TRACER_AI_LIVE_PRODUCTS_URL?.trim() || "";
  if (!url) return { configured: false, products: [] };
  const headers = { Accept: "application/json" };
  const productsToken = process.env.TRACER_AI_LIVE_PRODUCTS_TOKEN?.trim();
  if (productsToken) headers.Authorization = `Bearer ${productsToken}`;
  const response = await fetch(url, {
    method: "GET",
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return { configured: true, errorCode: "inventory_unverified", products: [] };
  const body = await response.json();
  if (!body || body.readOnly !== true || !Array.isArray(body.products)) {
    return { configured: true, errorCode: "inventory_unverified", products: [] };
  }
  return { configured: true, products: body.products };
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

async function verifyIntroduction(job, nowMs) {
  let catalog;
  try {
    catalog = await loadSellableProducts();
  } catch {
    return { ok: false, errorCode: "inventory_unverified" };
  }
  if (!catalog.configured) {
    const localLoopbackOverride = job.destination === "loopback"
      && process.env.TRACER_AI_LIVE_ALLOW_UNVERIFIED_LOOPBACK === "1";
    return localLoopbackOverride
      ? { ok: true, skipped: true }
      : { ok: false, errorCode: "inventory_unverified" };
  }
  if (catalog.errorCode) return { ok: false, errorCode: catalog.errorCode };
  for (const segment of job.segments || []) {
    if (typeof segment.sellingPrice !== "number" || typeof segment.inventory !== "number" || typeof segment.supplierFingerprint !== "string") {
      return { ok: false, errorCode: "stale_product_facts" };
    }
    const actual = catalog.products.map(factFromProduct).find((item) => item && item.id === segment.productId) || null;
    const compared = compareProductFacts({
      productId: segment.productId,
      sellingPrice: segment.sellingPrice,
      inventory: segment.inventory,
      supplierFingerprint: segment.supplierFingerprint,
    }, actual, nowMs);
    if (!compared.ok) return compared;
    if (segment.voiceId && !isRegisteredResidentVoice(segment.voiceId)) {
      return { ok: false, errorCode: "speech_provider_failed" };
    }
  }
  return { ok: true, skipped: false };
}

async function startMedia(job) {
  if (process.env.TRACER_AI_LIVE_MEDIA_HOLD === "1") {
    spawnHoldChild();
    return { ok: true };
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
  if (!plan.ok) return { ok: false, errorCode: plan.errorCode };
  const child = spawnFfmpeg(plan.args);
  if (!child.pid) return { ok: false, errorCode: "media_start_failed" };
  const spawned = await new Promise((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  if (!spawned) {
    killProcessTree(child.pid);
    return { ok: false, errorCode: "media_start_failed" };
  }
  child.once("exit", (code) => {
    if (code !== 0 && session.health.streamId === job.streamId && session.health.state === "live") {
      session.stop(job.streamId, "media_process_failed", new Date().toISOString(), "media_process_failed");
      haltChildren();
      persist();
    }
  });
  return { ok: true };
}

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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/ready")) {
      applyRuntimeLimit(Date.now());
      persist();
      const health = view(session.snapshot());
      if (url.pathname === "/health") {
        send(response, 200, health);
        return;
      }
      const decision = readyDecision(session.snapshot());
      send(response, decision.ready ? 200 : 503, {
        ok: decision.ready,
        ready: decision.ready,
        publicBroadcast: false,
        process: decision.process,
        session: decision.session,
        productFacts: decision.productFacts,
        destinationApproval: decision.destinationApproval,
      });
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
      const gate = body?.destination === "youtube" || body?.destination === "tiktok"
        ? openDestinationSocket({ destination: body.destination, env: process.env, connectImpl: connectApproved })
        : { opened: false, socket: null };
      const result = session.start(body, now);
      if (gate.opened && gate.socket && session.health.state !== "live") gate.socket.destroy?.();
      if (result.ok && result.health.state === "live" && !result.idempotent) {
        const facts = await verifyIntroduction(body, Date.parse(now));
        if (facts.skipped) {
          session.setProductFacts({ valid: null, reason: "not_configured" });
          await startMedia(body);
        }
        else if (!facts.ok) {
          session.setProductFacts({ valid: false, reason: facts.errorCode });
          const stopped = session.stop(String(body.streamId || ""), facts.errorCode === "inventory_unverified" ? "inventory_unverified" : "stale_product_facts", now, facts.errorCode);
          haltChildren();
          persist();
          send(response, 409, { ok: false, errorCode: facts.errorCode, health: view(stopped.health) });
          return;
        } else {
          session.setProductFacts({ valid: true, reason: null });
          const media = await startMedia(body);
          if (!media.ok) {
            session.setProductFacts({ valid: false, reason: media.errorCode });
            const stopped = session.stop(String(body.streamId || ""), media.errorCode, now, media.errorCode);
            haltChildren();
            persist();
            send(response, 409, { ok: false, errorCode: media.errorCode, health: view(stopped.health) });
            return;
          }
        }
      }
      persist();
      const introductionStopped = result.ok && session.health.state === "stopped" && Boolean(session.health.errorCode);
      const accepted = result.ok && !introductionStopped;
      send(response, accepted ? 200 : 409, {
        ok: accepted,
        ...(accepted ? {} : { errorCode: introductionStopped ? session.health.errorCode : result.errorCode }),
        ...(result.idempotent ? { idempotent: true } : {}),
        health: view(session.snapshot()),
      });
      return;
    }
    let result;
    if (url.pathname === "/stop") {
      result = session.stop(String(body.streamId || ""), String(body.reason || "operator_requested"), now);
      if (result.ok) haltChildren();
    } else if (url.pathname === "/reconnect") result = session.reconnect(now);
    else if (url.pathname === "/shutdown") {
      send(response, 200, { ok: true, publicBroadcast: false, state: "stopped" });
      shutdown("worker_shutdown");
      return;
    } else {
      send(response, 404, { ok: false, errorCode: "not_found", publicBroadcast: false });
      return;
    }
    persist();
    send(response, result.ok ? 200 : 409, { ...result, health: view(result.health) });
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
  persist();
}, 5_000).unref();
