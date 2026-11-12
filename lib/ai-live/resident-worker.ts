/**
 * In-process lifecycle for the long-running AI live worker.
 * Loopback means the local session is up. It never publishes to YouTube or TikTok.
 * Payloads and health records must not carry stream keys, RTMP URLs, or tokens.
 */

export const RESIDENT_RECONNECT_LIMIT = 3;
export const RESIDENT_MAX_RUNTIME_SECONDS = 1800;
const FACT_MAX_AGE_MS = 15 * 60 * 1000;
const INVENTED_CLAIM = /送料無料|割引|最安|治る|効果保証|残り\d+|今だけ|世界一|絶対に/;
const UNSAFE_KEY = /streamkey|rtmp|access[_-]?token|refresh[_-]?token|authorization|api[_-]?key|secret/i;

export type ResidentState =
  | "idle"
  | "starting"
  | "live"
  | "reconnecting"
  | "stopping"
  | "stopped"
  | "failed";

export type ResidentHealth = {
  ok: true;
  publicBroadcast: false;
  streamId: string | null;
  state: ResidentState;
  destination: "loopback" | "youtube" | "tiktok" | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  reconnectCount: number;
  currentSegmentId: string | null;
  stopReason: string | null;
  errorCode: string | null;
  maxRuntimeSeconds: number | null;
};

export type ResidentJob = {
  streamId: string;
  destination: "loopback" | "youtube" | "tiktok";
  destinationSecretRef: string;
  maxRuntimeSeconds: number;
  segments: Array<{
    id: string;
    productId: string;
    scriptText: string;
    factsVersion: string;
    factsVerifiedAt: string;
  }>;
};

export type ResidentResult =
  | { ok: true; health: ResidentHealth; idempotent?: boolean }
  | { ok: false; errorCode: string; health: ResidentHealth };

function emptyHealth(): ResidentHealth {
  return {
    ok: true,
    publicBroadcast: false,
    streamId: null,
    state: "idle",
    destination: null,
    startedAt: null,
    lastHeartbeatAt: null,
    reconnectCount: 0,
    currentSegmentId: null,
    stopReason: null,
    errorCode: null,
    maxRuntimeSeconds: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUnsafeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsafeKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (key === "destinationSecretRef") return false;
    return UNSAFE_KEY.test(key) || hasUnsafeKey(nested);
  });
}

export function validateResidentJob(input: unknown, nowMs: number): { ok: true; job: ResidentJob } | { ok: false; errorCode: string } {
  if (!isRecord(input)) return { ok: false, errorCode: "invalid_job" };
  const serialized = JSON.stringify(input);
  if (/rtmp:\/\//i.test(serialized) || hasUnsafeKey(input)) return { ok: false, errorCode: "credential_rejected" };
  const streamId = input.streamId;
  const destination = input.destination;
  const secretRef = input.destinationSecretRef;
  const maxRuntimeSeconds = input.maxRuntimeSeconds;
  const segments = input.segments;
  if (typeof streamId !== "string" || !/^[a-zA-Z0-9_-]{4,80}$/.test(streamId)) return { ok: false, errorCode: "invalid_stream_id" };
  if (destination !== "loopback" && destination !== "youtube" && destination !== "tiktok") return { ok: false, errorCode: "invalid_destination" };
  if (typeof secretRef !== "string" || secretRef.trim().length < 1 || secretRef.length > 120 || secretRef.includes("://")) {
    return { ok: false, errorCode: "invalid_secret_ref" };
  }
  if (!Number.isInteger(maxRuntimeSeconds) || Number(maxRuntimeSeconds) < 30 || Number(maxRuntimeSeconds) > RESIDENT_MAX_RUNTIME_SECONDS) {
    return { ok: false, errorCode: "invalid_runtime" };
  }
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 20) return { ok: false, errorCode: "invalid_segments" };
  const parsed: ResidentJob["segments"] = [];
  for (const segment of segments) {
    if (!isRecord(segment)) return { ok: false, errorCode: "invalid_segments" };
    const id = segment.id;
    const productId = segment.productId;
    const scriptText = segment.scriptText;
    const factsVersion = segment.factsVersion;
    const factsVerifiedAt = segment.factsVerifiedAt;
    if (typeof id !== "string" || typeof productId !== "string" || typeof scriptText !== "string") return { ok: false, errorCode: "invalid_segments" };
    if (typeof factsVersion !== "string" || typeof factsVerifiedAt !== "string") return { ok: false, errorCode: "invalid_segments" };
    if (scriptText.length < 1 || scriptText.length > 1200 || INVENTED_CLAIM.test(scriptText)) return { ok: false, errorCode: "script_rejected" };
    const verifiedAt = Date.parse(factsVerifiedAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt > nowMs + 60_000 || nowMs - verifiedAt > FACT_MAX_AGE_MS) {
      return { ok: false, errorCode: "stale_product_facts" };
    }
    parsed.push({ id, productId, scriptText, factsVersion, factsVerifiedAt });
  }
  return {
    ok: true,
    job: {
      streamId,
      destination,
      destinationSecretRef: secretRef.trim(),
      maxRuntimeSeconds: Number(maxRuntimeSeconds),
      segments: parsed,
    },
  };
}

export class ResidentSession {
  health: ResidentHealth = emptyHealth();

  snapshot(): ResidentHealth {
    return { ...this.health, publicBroadcast: false };
  }

  restore(saved: ResidentHealth | null): void {
    if (!saved || saved.publicBroadcast !== false) {
      this.health = emptyHealth();
      return;
    }
    if (saved.state !== "live" && saved.state !== "reconnecting") {
      this.health = emptyHealth();
      return;
    }
    this.health = { ...saved, ok: true, publicBroadcast: false, errorCode: null };
  }

  start(input: unknown, nowIso: string): ResidentResult {
    const nowMs = Date.parse(nowIso);
    const active = this.health.state === "starting" || this.health.state === "live" || this.health.state === "reconnecting";
    const validated = validateResidentJob(input, nowMs);
    if (!validated.ok) return { ok: false, errorCode: validated.errorCode, health: this.snapshot() };
    if (active && this.health.streamId === validated.job.streamId) {
      this.health.lastHeartbeatAt = nowIso;
      return { ok: true, health: this.snapshot(), idempotent: true };
    }
    if (active) return { ok: false, errorCode: "duplicate_stream", health: this.snapshot() };

    this.health = {
      ...emptyHealth(),
      streamId: validated.job.streamId,
      destination: validated.job.destination,
      state: "starting",
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      currentSegmentId: validated.job.segments[0]?.id ?? null,
      maxRuntimeSeconds: validated.job.maxRuntimeSeconds,
    };
    if (validated.job.destination !== "loopback") {
      this.health.state = "failed";
      this.health.errorCode = validated.job.destination === "youtube" ? "youtube_approval_required" : "tiktok_approval_required";
      this.health.stopReason = "stream_destination_rejected";
      return { ok: false, errorCode: this.health.errorCode, health: this.snapshot() };
    }
    this.health.state = "live";
    return { ok: true, health: this.snapshot() };
  }

  stop(streamId: string, reason: string, nowIso: string): ResidentResult {
    if (!this.health.streamId || this.health.streamId !== streamId) {
      return { ok: false, errorCode: "stream_not_found", health: this.snapshot() };
    }
    if (this.health.state === "stopped" || this.health.state === "idle" || this.health.state === "failed") {
      return { ok: true, health: this.snapshot(), idempotent: true };
    }
    this.health.state = "stopping";
    this.health.state = "stopped";
    this.health.stopReason = reason || "operator_requested";
    this.health.lastHeartbeatAt = nowIso;
    this.health.currentSegmentId = null;
    return { ok: true, health: this.snapshot() };
  }

  reconnect(nowIso: string): ResidentResult {
    if (this.health.state !== "live" && this.health.state !== "reconnecting") {
      return { ok: false, errorCode: "not_running", health: this.snapshot() };
    }
    this.health.state = "reconnecting";
    this.health.reconnectCount += 1;
    this.health.lastHeartbeatAt = nowIso;
    if (this.health.destination === "loopback" && this.health.reconnectCount <= RESIDENT_RECONNECT_LIMIT) {
      this.health.state = "live";
      this.health.errorCode = null;
      return { ok: true, health: this.snapshot() };
    }
    this.health.state = "failed";
    this.health.stopReason = "stream_destination_rejected";
    this.health.errorCode = this.health.reconnectCount > RESIDENT_RECONNECT_LIMIT
      ? "reconnect_budget_exhausted"
      : "destination_not_ready";
    this.health.currentSegmentId = null;
    return { ok: false, errorCode: this.health.errorCode, health: this.snapshot() };
  }

  expire(nowMs: number): ResidentHealth {
    if (this.health.state !== "live" && this.health.state !== "reconnecting") return this.snapshot();
    const started = Date.parse(this.health.startedAt || "");
    const limit = this.health.maxRuntimeSeconds ?? 0;
    if (!Number.isFinite(started) || limit < 30) return this.snapshot();
    if (nowMs < started + limit * 1000) return this.snapshot();
    this.health.state = "stopped";
    this.health.stopReason = "worker_shutdown";
    this.health.errorCode = "max_runtime_reached";
    this.health.currentSegmentId = null;
    this.health.lastHeartbeatAt = new Date(nowMs).toISOString();
    return this.snapshot();
  }
}
