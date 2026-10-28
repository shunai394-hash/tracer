/**
 * Contracts for the append-only commerce bot evidence ledger.
 * This module validates event payloads only; persistence is intentionally
 * handled separately by authenticated server-side code using service_role.
 */

export const COMMERCE_BOT_RUN_STATUSES = [
  "not-run",
  "running",
  "passed",
  "blocked",
  "partial",
  "failed",
] as const;

export const COMMERCE_BOT_RUN_EVENT_TYPES = [
  "run_started",
  "evidence_recorded",
  "blocked",
  "passed",
  "partial",
  "failed",
  "run_finished",
] as const;

export type CommerceBotRunStatus = (typeof COMMERCE_BOT_RUN_STATUSES)[number];
export type CommerceBotRunEventType = (typeof COMMERCE_BOT_RUN_EVENT_TYPES)[number];

export type CommerceBotRunEventInput = {
  runId: string;
  botId: "main" | "product-monitor" | "japanese-copy" | "channel-sync" | "qa";
  eventType: CommerceBotRunEventType;
  status: CommerceBotRunStatus;
  inputSnapshotHash?: string | null;
  evidenceRefs?: string[];
  blockers?: Array<{ code: string; detail: string; severity?: "low" | "medium" | "high" }>;
  retryCount?: number;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
};

export type CommerceBotRunEventValidation =
  | { ok: true; value: CommerceBotRunEventInput }
  | { ok: false; errors: string[] };

const BOT_IDS = new Set(["main", "product-monitor", "japanese-copy", "channel-sync", "qa"]);
const EVENT_TYPES = new Set<string>(COMMERCE_BOT_RUN_EVENT_TYPES);
const STATUSES = new Set<string>(COMMERCE_BOT_RUN_STATUSES);

export function validateCommerceBotRunEvent(
  input: unknown,
): CommerceBotRunEventValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["event must be an object"] };
  }

  const value = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof value.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.runId)) {
    errors.push("runId must be a UUID");
  }
  if (typeof value.botId !== "string" || !BOT_IDS.has(value.botId)) errors.push("botId is invalid");
  if (typeof value.eventType !== "string" || !EVENT_TYPES.has(value.eventType)) errors.push("eventType is invalid");
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) errors.push("status is invalid");
  if (value.inputSnapshotHash != null && (typeof value.inputSnapshotHash !== "string" || value.inputSnapshotHash.length > 256)) {
    errors.push("inputSnapshotHash must be a string of at most 256 characters");
  }
  if (value.evidenceRefs != null && (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length > 2048))) {
    errors.push("evidenceRefs must be an array of strings up to 2048 characters each");
  }
  if (value.blockers != null && (!Array.isArray(value.blockers) || value.blockers.some((blocker) =>
    !blocker || typeof blocker !== "object" || Array.isArray(blocker) ||
    typeof (blocker as Record<string, unknown>).code !== "string" ||
    typeof (blocker as Record<string, unknown>).detail !== "string" ||
    ((blocker as Record<string, unknown>).severity != null && !["low", "medium", "high"].includes(String((blocker as Record<string, unknown>).severity)))
  ))) {
    errors.push("blockers must contain code/detail objects with optional valid severity");
  }
  if (value.retryCount != null && (!Number.isInteger(value.retryCount) || Number(value.retryCount) < 0)) {
    errors.push("retryCount must be a non-negative integer");
  }
  if (value.idempotencyKey != null && (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length > 256)) {
    errors.push("idempotencyKey must be a string of at most 256 characters");
  }
  if (value.metadata != null && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))) {
    errors.push("metadata must be an object");
  }
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      runId: value.runId as string,
      botId: value.botId as CommerceBotRunEventInput["botId"],
      eventType: value.eventType as CommerceBotRunEventType,
      status: value.status as CommerceBotRunStatus,
      ...(value.inputSnapshotHash == null ? {} : { inputSnapshotHash: value.inputSnapshotHash as string }),
      evidenceRefs: (value.evidenceRefs as string[] | undefined) ?? [],
      blockers: (value.blockers as CommerceBotRunEventInput["blockers"]) ?? [],
      retryCount: (value.retryCount as number | undefined) ?? 0,
      idempotencyKey: (value.idempotencyKey as string | null | undefined) ?? null,
      metadata: (value.metadata as Record<string, unknown> | undefined) ?? {},
    },
  };
}
