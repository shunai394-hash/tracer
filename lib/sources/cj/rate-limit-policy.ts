export type CJRateLimitDiagnostic = {
  code?: number;
  message?: string;
  pointsInfo?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Distinguish exhausted daily API points from a transient QPS throttle. */
export function isCJQuotaExhausted(diagnostic: CJRateLimitDiagnostic): boolean {
  if (
    diagnostic.code === 16900500 ||
    /insufficient api points|api points exhausted/i.test(diagnostic.message ?? "")
  ) {
    return true;
  }

  // CJ may return remaining=0 in a QPS-throttle payload. That is not proof
  // that the daily points quota is exhausted: never turn a 1-QPS 429 into a
  // 24-hour circuit break unless the provider explicitly identifies points
  // exhaustion (above).
  const points = asRecord(diagnostic.pointsInfo);
  const quotaMessage = /quota exhausted|points exhausted|insufficient api points/i.test(diagnostic.message ?? "");
  const remaining = Number(points.remaining);
  return quotaMessage && Number.isFinite(remaining) && remaining <= 0;
}

/** Use a conservative cooldown because CJ's quota reset timezone is not guaranteed. */
export function getCJQuotaCooldownUntil(nowMs = Date.now()): string {
  return new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
}
