/**
 * Delivery ledger for canonical commerce listings (commerce_variants that are
 * published on Shopify) sent to NEWFIND. The legacy ledger
 * newfind_promotion_deliveries has a foreign key to shop_listings, so these
 * deliveries are recorded as one commerce_events row per variant instead:
 * event_key = newfind_commerce:<variantId>, status = the delivery state and
 * detail = attempts, lease and receiver ACK. Claims are compare-and-set on
 * status (and on the lease for an abandoned "sending" row), so two runs never
 * send the same variant at the same time.
 */

export const NEWFIND_COMMERCE_EVENT_TYPE = "newfind_commerce_delivery";
export const NEWFIND_COMMERCE_LEASE_MS = 2 * 60_000;
export const NEWFIND_COMMERCE_MAX_ATTEMPTS = 8;

export type NewfindCommerceStatus = "pending" | "sending" | "sent" | "processed" | "failed";

export type NewfindCommerceDetail = {
  eventId: string;
  attempts: number;
  leaseUntil: string | null;
  lastAttemptAt: string | null;
  httpStatus: number | null;
  ackStatus: string | null;
  lastError: string | null;
  processedAt: string | null;
};

export type NewfindCommerceRow = { status: string; detail: unknown };

export function newfindCommerceEventKey(variantId: string): string {
  return `newfind_commerce:${variantId}`;
}

export function newfindCommerceProductEventKey(productId: string): string {
  return `newfind_commerce_product:${productId}`;
}

export function newfindCommerceProductEventId(productId: string): string {
  return `tracer-commerce-product:${productId}`;
}

/** Receiver idempotency key; stable across retries of the same variant. */
export function newfindCommerceEventId(variantId: string): string {
  return `tracer-commerce-variant:${variantId}`;
}

export function initialNewfindCommerceDetail(variantId: string): NewfindCommerceDetail {
  return { eventId: newfindCommerceEventId(variantId), attempts: 0, leaseUntil: null, lastAttemptAt: null, httpStatus: null, ackStatus: null, lastError: null, processedAt: null };
}

export function readNewfindCommerceDetail(variantId: string, value: unknown): NewfindCommerceDetail {
  const base = initialNewfindCommerceDetail(variantId);
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" && raw[key] ? String(raw[key]) : null);
  const attempts = Number(raw.attempts);
  const httpStatus = Number(raw.httpStatus);
  return {
    eventId: text("eventId") ?? base.eventId,
    attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
    leaseUntil: text("leaseUntil"),
    lastAttemptAt: text("lastAttemptAt"),
    httpStatus: Number.isInteger(httpStatus) && httpStatus > 0 ? httpStatus : null,
    ackStatus: text("ackStatus"),
    lastError: text("lastError"),
    processedAt: text("processedAt"),
  };
}

/** Wait before resending: 5, 10, 20 ... minutes, capped at 6 hours. */
export function newfindCommerceBackoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.max(0, attempts - 1));
}

export type NewfindCommerceDecision =
  | { action: "send"; fromStatus: NewfindCommerceStatus | "missing"; detail: NewfindCommerceDetail }
  | { action: "skip"; reason: "already_processed" | "in_progress" | "backoff" | "max_attempts" };

/** Decides whether this run may claim and send the variant. */
export function decideNewfindCommerceDelivery(variantId: string, row: NewfindCommerceRow | null, nowMs: number): NewfindCommerceDecision {
  if (!row) return { action: "send", fromStatus: "missing", detail: initialNewfindCommerceDetail(variantId) };
  const detail = readNewfindCommerceDetail(variantId, row.detail);
  const status = row.status as NewfindCommerceStatus;
  if (status === "processed") return { action: "skip", reason: "already_processed" };
  if (status === "sending") {
    const lease = detail.leaseUntil ? Date.parse(detail.leaseUntil) : Number.NaN;
    if (Number.isFinite(lease) && lease > nowMs) return { action: "skip", reason: "in_progress" };
  } else if (status !== "pending" && status !== "sent" && status !== "failed") {
    return { action: "skip", reason: "in_progress" };
  }
  const last = detail.lastAttemptAt ? Date.parse(detail.lastAttemptAt) : Number.NaN;
  // A receiver fix is deployed. Permit one bounded recovery attempt for known
  // duplicate-key failures from older senders that already reached attempt 9.
  // Attempts beyond that remain terminal; unrelated failures keep the normal cap.
  const duplicateConflictRecovery = status === "failed"
    && detail.attempts >= 4
    && /discovery insert failed: duplicate key value violates unique constraint/i.test(detail.lastError ?? "");
  // NEWFIND fixed its required confidence_score normalization in production.
  // Permit at most two bounded sends at the attempt cap and one beyond it, so
  // a replay that races the receiver deployment can be retried once after it
  // lands. The same event ID remains idempotent; attempt 10 is terminal.
  const confidenceScoreRecovery = status === "failed"
    && detail.attempts >= NEWFIND_COMMERCE_MAX_ATTEMPTS
    && detail.attempts <= NEWFIND_COMMERCE_MAX_ATTEMPTS + 1
    && /confidence_score.*violates not-null constraint/i.test(detail.lastError ?? "");
  const oneRecoveryBeyondCap = duplicateConflictRecovery
    && detail.attempts === NEWFIND_COMMERCE_MAX_ATTEMPTS + 1;
  if (
    detail.attempts >= NEWFIND_COMMERCE_MAX_ATTEMPTS
    && !(detail.attempts === NEWFIND_COMMERCE_MAX_ATTEMPTS && duplicateConflictRecovery)
    && !confidenceScoreRecovery
    && !oneRecoveryBeyondCap
  ) return { action: "skip", reason: "max_attempts" };
  if (status !== "pending" && !duplicateConflictRecovery && !confidenceScoreRecovery && Number.isFinite(last) && nowMs - last < newfindCommerceBackoffMs(detail.attempts)) {
    return { action: "skip", reason: "backoff" };
  }
  return { action: "send", fromStatus: status, detail };
}

/** Ledger state after the receiver answered (or did not). */
export function newfindCommerceOutcome(response: { ok: boolean; status: number; ackStatus: string | null } | null): "processed" | "sent" | "failed" {
  if (!response) return "failed";
  if (response.ackStatus === "processed" || response.ackStatus === "duplicate") return "processed";
  return response.ok ? "sent" : "failed";
}
