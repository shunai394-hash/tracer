import http from "node:http";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { createSupabaseAiLiveStore } from "./supabase-ai-live-store.mjs";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RUNTIME_SECONDS = 30 * 60;
const MIN_RUNTIME_SECONDS = 30;
const MAX_FACT_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const DEFAULT_SEGMENT_DURATION_SECONDS = 45;
const MIN_SEGMENT_DURATION_SECONDS = 15;
const MAX_SEGMENT_DURATION_SECONDS = 600;
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
  if (typeof job.destinationSecretRef !== "string" || !/^[A-Za-z0-9_:-]+(?:\/[A-Za-z0-9_:-]+){0,7}$/.test(job.destinationSecretRef)) return "invalid_secret_reference";
  if (!Number.isInteger(job.maxRuntimeSeconds) || job.maxRuntimeSeconds < MIN_RUNTIME_SECONDS || job.maxRuntimeSeconds > MAX_RUNTIME_SECONDS) return "runtime_out_of_bounds";
  if (!Array.isArray(job.segments) || job.segments.length < 1 || job.segments.length > 20) return "invalid_segments";
  if (job.segmentDurationSeconds !== undefined &&
      (!Number.isInteger(job.segmentDurationSeconds) ||
       job.segmentDurationSeconds < MIN_SEGMENT_DURATION_SECONDS ||
       job.segmentDurationSeconds > MAX_SEGMENT_DURATION_SECONDS)) return "segment_duration_out_of_bounds";
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
  segmentIntervalMs = null,
  store = null,
  workerId = randomUUID().replaceAll("-", "_"),
} = {}) {
  if (!token || token.length < 32) throw new Error("AI_LIVE_WORKER_TOKEN must contain at least 32 characters");
  if (mode !== "fake") throw new Error("Only the fake adapter is implemented; live publishing is disabled");
  const streams = new Map();
  let recoveryTimer = null;
  if (store && (typeof store.insertNew !== "function" || typeof store.claimLease !== "function" ||
      typeof store.heartbeat !== "function" || typeof store.markStopped !== "function")) {
    throw new Error("invalid_ai_live_store");
  }
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(workerId)) throw new Error("invalid_worker_id");

  function authorized(req) {
    const header = req.headers.authorization || "";
    return header.startsWith("Bearer ") && safeEqual(header.slice(7), token);
  }

  function snapshot(record) {
    return {
      streamId: record.job.streamId,
      state: record.state,
      startedAt: record.startedAt,
      lastHeartbeatAt: record.lastHeartbeatAt,
      reconnectCount: 0,
      currentSegmentId: record.job.segments[record.segmentIndex]?.id || null,
      segmentIndex: record.segmentIndex,
      segmentCount: record.job.segments.length,
      segmentChangedAt: record.segmentChangedAt,
      stopReason: record.stopReason,
      errorCode: null,
      adapterMode: "fake",
      simulated: true,
    };
  }

  function stopRecord(record, reason) {
    clearTimeout(record.timer);
    clearInterval(record.segmentTimer);
    clearInterval(record.heartbeatTimer);
    record.state = "stopped";
    record.stopReason = reason;
    record.lastHeartbeatAt = new Date(now()).toISOString();
    if (store && reason !== "worker_lease_lost") {
      void store.markStopped(record.job.streamId, { reason, owner: workerId }).catch(() => {});
    }
  }

  function activateRecord(record) {
    const elapsed = Math.max(0, now() - Date.parse(record.startedAt));
    const remainingMs = record.job.maxRuntimeSeconds * 1000 - elapsed;
    if (remainingMs <= 0) {
      stopRecord(record, "worker_runtime_limit");
      return false;
    }
    record.timer = setTimeout(() => stopRecord(record, "worker_runtime_limit"), remainingMs);
    record.timer.unref?.();
    const durationMs = segmentIntervalMs ??
      (record.job.segmentDurationSeconds ?? DEFAULT_SEGMENT_DURATION_SECONDS) * 1000;
    if (record.job.segments.length > 1) {
      record.segmentTimer = setInterval(() => {
        if (record.state !== "live") return;
        record.segmentIndex = (record.segmentIndex + 1) % record.job.segments.length;
        record.segmentChangedAt = new Date(now()).toISOString();
        record.lastHeartbeatAt = record.segmentChangedAt;
      }, durationMs);
      record.segmentTimer.unref?.();
    }
    if (store) {
      record.heartbeatTimer = setInterval(async () => {
        if (record.state !== "live") return;
        try {
          const renewed = await store.heartbeat(record.job.streamId, {
            owner: workerId,
            segmentIndex: record.segmentIndex,
            productId: record.job.segments[record.segmentIndex]?.productId || null,
            reconnectCount: 0,
            leaseSeconds: 45,
            now: new Date(now()),
          });
          if (!renewed) stopRecord(record, "worker_lease_lost");
          else record.lastHeartbeatAt = new Date(now()).toISOString();
        } catch {
          stopRecord(record, "worker_lease_lost");
        }
      }, 15_000);
      record.heartbeatTimer.unref?.();
    }
    return true;
  }

  async function restoreActiveStreams() {
    if (!store) return { restored: 0, skipped: 0 };
    const rows = await store.listActive();
    let restored = 0;
    let skipped = 0;
    for (const row of rows) {
      if (streams.has(row.stream_id)) {
        skipped += 1;
        continue;
      }
      if (row.adapter_mode !== "fake" || !row.job_payload || row.status === "stopped") {
        skipped += 1;
        continue;
      }
      const job = row.job_payload;
      const lease = await store.claimLease(row.stream_id, { owner: workerId, leaseSeconds: 45 });
      if (!lease) {
        skipped += 1;
        continue;
      }
      const validationError = validateJob(job, now());
      const fingerprint = createHash("sha256").update(JSON.stringify(job)).digest("hex");
      if (validationError || fingerprint !== row.job_fingerprint ||
          !Number.isInteger(row.active_segment_index) ||
          row.active_segment_index < 0 || row.active_segment_index >= job.segments.length) {
        await store.markStopped(row.stream_id, { reason: "restore_validation_failed", owner: workerId });
        skipped += 1;
        continue;
      }
      const startedAt = row.started_at || new Date(now()).toISOString();
      const record = {
        job,
        fingerprint,
        state: "live",
        startedAt,
        lastHeartbeatAt: row.heartbeat_at || startedAt,
        segmentChangedAt: row.heartbeat_at || startedAt,
        segmentIndex: row.active_segment_index,
        stopReason: null,
        timer: null,
        segmentTimer: null,
        heartbeatTimer: null,
      };
      streams.set(job.streamId, record);
      if (activateRecord(record)) restored += 1;
      else skipped += 1;
    }
    return { restored, skipped };
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
        const record = {
          job,
          fingerprint,
          state: "live",
          startedAt,
          lastHeartbeatAt: startedAt,
          segmentChangedAt: startedAt,
          segmentIndex: 0,
          stopReason: null,
          timer: null,
          segmentTimer: null,
          heartbeatTimer: null,
        };
        if (store) {
          const inserted = await store.insertNew({
            streamId: job.streamId,
            destination: job.destination,
            status: "live",
            adapterMode: "fake",
            jobFingerprint: fingerprint,
            jobPayload: job,
            activeSegmentIndex: 0,
            activeProductId: job.segments[0]?.productId || null,
            reconnectCount: 0,
            heartbeatAt: startedAt,
            startedAt,
          });
          if (!inserted) return json(res, 409, { error: "stream_id_already_persisted" });
          const lease = await store.claimLease(job.streamId, { owner: workerId, leaseSeconds: 45 });
          if (!lease) return json(res, 409, { error: "worker_lease_unavailable" });
        }
        streams.set(job.streamId, record);
        if (!activateRecord(record)) return json(res, 409, { error: "worker_runtime_limit_reached" });
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
          stopRecord(record, "operator_requested");
        }
        return json(res, 200, snapshot(record));
      }
      return json(res, 404, { error: "not_found" });
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : "internal_error" });
    }
  });

  server.restoreActiveStreams = restoreActiveStreams;
  server.startRecoveryLoop = (intervalMs = 15_000) => {
    if (!Number.isInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 60_000) {
      throw new Error("invalid_recovery_interval");
    }
    if (recoveryTimer) return;
    recoveryTimer = setInterval(() => {
      void restoreActiveStreams().catch(() => {});
    }, intervalMs);
    recoveryTimer.unref?.();
  };
  server.on("close", () => {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
    for (const record of streams.values()) {
      clearTimeout(record.timer);
      clearInterval(record.segmentTimer);
      clearInterval(record.heartbeatTimer);
    }
  });
  return server;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the isolated worker");
  }
  const store = createSupabaseAiLiveStore({ url: supabaseUrl, serviceRoleKey });
  const server = createAiLiveWorkerServer({ store });
  const port = Number(process.env.PORT || 8080);
  await server.restoreActiveStreams();
  server.startRecoveryLoop();
  server.listen(port, "0.0.0.0", () => process.stdout.write("AI Live worker control API ready (fake adapter; publishing disabled)\n"));
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
