import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RUNTIME_SECONDS = 30 * 60;
const MIN_RUNTIME_SECONDS = 30;
const MAX_FACT_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const FORBIDDEN_KEYS = /^(?:rtmpUrl|streamKey|stream_key|accessToken|access_token|cookie|destinationUrl|destination_url)$/i;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}
function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function containsForbiddenKey(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key) || containsForbiddenKey(child)) return true;
  }
  return false;
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}
function validateJob(job, now = Date.now()) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return "invalid_job";
  if (containsForbiddenKey(job)) return "credentials_must_not_be_in_job";
  if (typeof job.streamId !== "string" || !/^[A-Za-z0-9_-]{8,96}$/.test(job.streamId)) return "invalid_stream_id";
  if (typeof job.destination !== "string" || !/^(youtube_live|tiktok_live)$/.test(job.destination)) return "unsupported_destination";
  // Secret references may be hierarchical paths in a secret manager.
  if (typeof job.destinationSecretRef !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(job.destinationSecretRef)) return "invalid_secret_reference";
  if (!Number.isInteger(job.maxRuntimeSeconds) || job.maxRuntimeSeconds < MIN_RUNTIME_SECONDS || job.maxRuntimeSeconds > MAX_RUNTIME_SECONDS) return "runtime_out_of_bounds";
  if (!Array.isArray(job.segments) || job.segments.length < 1 || job.segments.length > 20) return "invalid_segments";
  for (const segment of job.segments) {
    if (!segment || typeof segment !== "object") return "invalid_segment";
    if (typeof segment.id !== "string" || segment.id.length < 1 || segment.id.length > 96) return "invalid_segment_id";
    if (typeof segment.productId !== "string" || segment.productId.length < 1 || segment.productId.length > 128) return "invalid_product_id";
    if (typeof segment.scriptText !== "string" || segment.scriptText.length > 5000) return "invalid_script";
    if (typeof segment.factsVersion !== "string" || !segment.factsVersion) return "missing_facts_version";
    const verifiedAt = Date.parse(segment.factsVerifiedAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt > now + MAX_FUTURE_SKEW_MS || now - verifiedAt > MAX_FACT_AGE_MS) return "stale_product_facts";
  }
  return null;
}
export function createAiLiveWorkerServer({
  token = process.env.AI_LIVE_WORKER_TOKEN,
  mode = process.env.AI_LIVE_WORKER_MODE || "fake",
  now = () => Date.now(),
} = {}) {
  if (!token || token.length < 32) throw new Error("AI_LIVE_WORKER_TOKEN must contain at least 32 characters");
  if (mode !== "fake") throw new Error("Only the fake adapter is implemented; live publishing is disabled");
  const streams = new Map();
  function authorized(req) {
    const header = req.headers.authorization || "";
    return header.startsWith("Bearer ") && safeEqual(header.slice(7), token);
  }
  function snapshot(record) {
    return {
      streamId: record.job.streamId, state: record.state, startedAt: record.startedAt,
      lastHeartbeatAt: record.lastHeartbeatAt, reconnectCount: 0,
      currentSegmentId: record.job.segments[0]?.id || null, stopReason: record.stopReason,
      errorCode: null, adapterMode: "fake", simulated: true,
    };
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/readyz") return json(res, 200, { ready: true, mode: "fake", livePublishingEnabled: false });
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    try {
      if (req.method === "POST" && url.pathname === "/v1/streams") {
        const job = await readJson(req);
        const validationError = validateJob(job, now());
        if (validationError) return json(res, 422, { error: validationError });
        const fingerprint = createHash("sha256").update(JSON.stringify(job)).digest("hex");
        const existing = streams.get(job.streamId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) return json(res, 409, { error: "stream_id_conflict" });
          return json(res, 200, snapshot(existing));
        }
        const startedAt = new Date(now()).toISOString();
        const record = { job, fingerprint, state: "live", startedAt, lastHeartbeatAt: startedAt, stopReason: null, timer: null };
        record.timer = setTimeout(() => {
          record.state = "stopped";
          record.stopReason = "worker_shutdown";
          record.lastHeartbeatAt = new Date(now()).toISOString();
        }, job.maxRuntimeSeconds * 1000);
        record.timer.unref?.();
        streams.set(job.streamId, record);
        return json(res, 202, snapshot(record));
      }
      const match = url.pathname.match(/^\/v1\/streams\/([A-Za-z0-9_-]{8,96})(?:\/(stop))?$/);
      if (match && req.method === "GET" && !match[2]) {
        const record = streams.get(match[1]);
        return record ? json(res, 200, snapshot(record)) : json(res, 404, { error: "stream_not_found" });
      }
      if (match && req.method === "POST" && match[2] === "stop") {
        const record = streams.get(match[1]);
        if (!record) return json(res, 404, { error: "stream_not_found" });
        if (record.state !== "stopped" && record.state !== "failed") {
          clearTimeout(record.timer);
          record.state = "stopped";
          record.stopReason = "operator_requested";
          record.lastHeartbeatAt = new Date(now()).toISOString();
        }
        return json(res, 200, snapshot(record));
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : "internal_error" });
    }
  });
  server.on("close", () => {
    for (const record of streams.values()) clearTimeout(record.timer);
  });
  return server;
}
const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const server = createAiLiveWorkerServer();
  const port = Number(process.env.PORT || 8080);
  server.listen(port, "0.0.0.0", () => process.stdout.write("AI Live worker control API ready (fake adapter; publishing disabled)\n"));
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
