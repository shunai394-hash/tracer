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

export type ResidentProductFacts = {
  valid: boolean | null;
  reason: string | null;
};

export type ResidentFactExpectation = {
  productId: string;
  sellingPrice: number;
  inventory: number;
  supplierFingerprint: string;
};

export type ResidentHealth = {
  ok: true;
  publicBroadcast: false;
  process: "running";
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
  productFacts: ResidentProductFacts;
  factExpectations: ResidentFactExpectation[];
  mediaReady: boolean;
  childPids: number[];
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
    sellingPrice?: number;
    inventory?: number;
    supplierFingerprint?: string;
    voiceId?: string;
  }>;
};

export type ResidentResult =
  | { ok: true; health: ResidentHealth; idempotent?: boolean }
  | { ok: false; errorCode: string; health: ResidentHealth };

function emptyProductFacts(): ResidentProductFacts {
  return { valid: null, reason: null };
}

function childPidsFrom(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((pid): pid is number => Number.isInteger(pid) && Number(pid) > 0).slice(0, 20);
}

function emptyHealth(): ResidentHealth {
  return {
    ok: true,
    publicBroadcast: false,
    process: "running",
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
    productFacts: emptyProductFacts(),
    factExpectations: [],
    mediaReady: false,
    childPids: [],
  };
}

function factExpectationsFrom(value: unknown): ResidentFactExpectation[] {
  if (!Array.isArray(value)) return [];
  const parsed: ResidentFactExpectation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.productId !== "string" || typeof row.sellingPrice !== "number" || !Number.isInteger(row.inventory)) continue;
    if (typeof row.supplierFingerprint !== "string" || !/^[a-f0-9]{32}$/.test(row.supplierFingerprint)) continue;
    parsed.push({
      productId: row.productId,
      sellingPrice: row.sellingPrice,
      inventory: Number(row.inventory),
      supplierFingerprint: row.supplierFingerprint,
    });
  }
  return parsed.slice(0, 20);
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
    const sellingPrice = segment.sellingPrice;
    const inventory = segment.inventory;
    const supplierFingerprint = segment.supplierFingerprint;
    const voiceId = segment.voiceId;
    if (sellingPrice !== undefined && (typeof sellingPrice !== "number" || !Number.isFinite(sellingPrice) || sellingPrice <= 0)) {
      return { ok: false, errorCode: "invalid_segments" };
    }
    if (inventory !== undefined && (!Number.isInteger(inventory) || Number(inventory) <= 0)) return { ok: false, errorCode: "invalid_segments" };
    if (supplierFingerprint !== undefined && (typeof supplierFingerprint !== "string" || !/^[a-f0-9]{32}$/.test(supplierFingerprint))) {
      return { ok: false, errorCode: "invalid_segments" };
    }
    if (voiceId !== undefined && (typeof voiceId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(voiceId))) {
      return { ok: false, errorCode: "invalid_segments" };
    }
    parsed.push({
      id,
      productId,
      scriptText,
      factsVersion,
      factsVerifiedAt,
      ...(typeof sellingPrice === "number" ? { sellingPrice } : {}),
      ...(typeof inventory === "number" ? { inventory } : {}),
      ...(typeof supplierFingerprint === "string" ? { supplierFingerprint } : {}),
      ...(typeof voiceId === "string" ? { voiceId } : {}),
    });
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
    return {
      ...this.health,
      publicBroadcast: false,
      process: "running",
      productFacts: { ...this.health.productFacts },
      factExpectations: this.health.factExpectations.map((item) => ({ ...item })),
      mediaReady: this.health.mediaReady === true,
      childPids: [...this.health.childPids],
    };
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
    this.health = {
      ...emptyHealth(),
      ...saved,
      ok: true,
      publicBroadcast: false,
      process: "running",
      errorCode: null,
      productFacts: saved.productFacts?.valid === true || saved.productFacts?.valid === false || saved.productFacts?.reason
        ? { valid: saved.productFacts.valid ?? null, reason: saved.productFacts.reason ?? null }
        : emptyProductFacts(),
      factExpectations: factExpectationsFrom(saved.factExpectations),
      mediaReady: false,
      childPids: childPidsFrom(saved.childPids),
    };
  }

  setProductFacts(facts: ResidentProductFacts): void {
    this.health.productFacts = { valid: facts.valid, reason: facts.reason };
  }

  setFactExpectations(expectations: ResidentFactExpectation[]): void {
    this.health.factExpectations = factExpectationsFrom(expectations);
  }

  setMediaReady(ready: boolean): void {
    this.health.mediaReady = ready === true;
  }

  /**
   * Records a rejected start without ever entering live.
   * The session is stopped so callers can see the reason.
   */
  recordRejection(input: unknown, nowIso: string, errorCode: string): ResidentResult {
    const validated = validateResidentJob(input, Date.parse(nowIso));
    if (!validated.ok) return { ok: false, errorCode: validated.errorCode, health: this.snapshot() };
    const active = this.health.state === "starting" || this.health.state === "live" || this.health.state === "reconnecting";
    if (active && this.health.streamId !== validated.job.streamId) {
      return { ok: false, errorCode: "duplicate_stream", health: this.snapshot() };
    }
    if (active && this.health.state !== "starting") {
      return this.stop(validated.job.streamId, errorCode, nowIso, errorCode);
    }
    this.health = {
      ...emptyHealth(),
      streamId: validated.job.streamId,
      destination: validated.job.destination,
      state: "stopped",
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      currentSegmentId: null,
      stopReason: errorCode,
      errorCode,
      maxRuntimeSeconds: validated.job.maxRuntimeSeconds,
      productFacts: { valid: false, reason: errorCode },
      mediaReady: false,
    };
    return { ok: false, errorCode, health: this.snapshot() };
  }

  /**
   * Enters starting only after product facts have already been verified.
   * Loopback stays in starting until commitLive().
   */
  beginStart(input: unknown, nowIso: string, expectations: ResidentFactExpectation[]): ResidentResult {
    const active = this.health.state === "starting" || this.health.state === "live" || this.health.state === "reconnecting";
    const validated = validateResidentJob(input, Date.parse(nowIso));
    if (!validated.ok) return { ok: false, errorCode: validated.errorCode, health: this.snapshot() };
    if (active && this.health.streamId === validated.job.streamId) {
      if (this.health.state === "starting") return { ok: false, errorCode: "start_in_progress", health: this.snapshot() };
      this.health.lastHeartbeatAt = nowIso;
      return { ok: true, health: this.snapshot(), idempotent: true };
    }
    if (active) return { ok: false, errorCode: "duplicate_stream", health: this.snapshot() };
    const stored = factExpectationsFrom(expectations);
    if (stored.length < 1 || stored.length !== expectations.length) {
      return { ok: false, errorCode: "stale_product_facts", health: this.snapshot() };
    }
    this.health = {
      ...emptyHealth(),
      streamId: validated.job.streamId,
      destination: validated.job.destination,
      state: "starting",
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      currentSegmentId: validated.job.segments[0]?.id ?? null,
      maxRuntimeSeconds: validated.job.maxRuntimeSeconds,
      productFacts: { valid: true, reason: null },
      factExpectations: stored,
      mediaReady: false,
    };
    if (validated.job.destination !== "loopback") {
      this.health.state = "failed";
      this.health.errorCode = validated.job.destination === "youtube" ? "youtube_approval_required" : "tiktok_approval_required";
      this.health.stopReason = "stream_destination_rejected";
      this.health.productFacts = { valid: false, reason: this.health.errorCode };
      return { ok: false, errorCode: this.health.errorCode, health: this.snapshot() };
    }
    return { ok: true, health: this.snapshot() };
  }

  /** Moves starting to live only when verified facts and running media are both present. */
  commitLive(nowIso: string): ResidentResult {
    if (this.health.state !== "starting") return { ok: false, errorCode: "not_starting", health: this.snapshot() };
    if (this.health.destination !== "loopback" || this.health.productFacts.valid !== true || this.health.factExpectations.length < 1 || this.health.mediaReady !== true) {
      return { ok: false, errorCode: "media_not_ready", health: this.snapshot() };
    }
    this.health.state = "live";
    this.health.lastHeartbeatAt = nowIso;
    this.health.errorCode = null;
    return { ok: true, health: this.snapshot() };
  }

  trackChild(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0 || this.health.childPids.includes(pid)) return;
    this.health.childPids = [...this.health.childPids, pid].slice(-20);
  }

  clearChildren(): number[] {
    const pids = this.health.childPids;
    this.health.childPids = [];
    return pids;
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

  stop(streamId: string, reason: string, nowIso: string, errorCode: string | null = null): ResidentResult {
    if (!this.health.streamId || this.health.streamId !== streamId) {
      return { ok: false, errorCode: "stream_not_found", health: this.snapshot() };
    }
    if (this.health.state === "stopped" || this.health.state === "idle" || this.health.state === "failed") {
      return { ok: true, health: this.snapshot(), idempotent: true };
    }
    this.health.state = "stopping";
    this.health.state = "stopped";
    this.health.stopReason = reason || "operator_requested";
    this.health.errorCode = errorCode;
    this.health.mediaReady = false;
    this.health.lastHeartbeatAt = nowIso;
    this.health.currentSegmentId = null;
    return { ok: true, health: this.snapshot() };
  }

  fail(streamId: string, reason: string, nowIso: string, errorCode: string): ResidentResult {
    if (!this.health.streamId || this.health.streamId !== streamId) {
      return { ok: false, errorCode: "stream_not_found", health: this.snapshot() };
    }
    if (this.health.state === "failed" || this.health.state === "stopped" || this.health.state === "idle") {
      return { ok: true, health: this.snapshot(), idempotent: true };
    }
    this.health.state = "failed";
    this.health.stopReason = reason;
    this.health.errorCode = errorCode;
    this.health.mediaReady = false;
    this.health.lastHeartbeatAt = nowIso;
    this.health.currentSegmentId = null;
    return { ok: false, errorCode, health: this.snapshot() };
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
    this.health.mediaReady = false;
    this.health.currentSegmentId = null;
    this.health.lastHeartbeatAt = new Date(nowMs).toISOString();
    return this.snapshot();
  }
}
