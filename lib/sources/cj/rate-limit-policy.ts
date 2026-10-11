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

/** True only when the provider explicitly reports that no API quota remains. */
export function isCJQuotaExhausted(diagnostic: CJRateLimitDiagnostic): boolean {
  if (
    diagnostic.code === 16900500 ||
    /insufficient api points|api points exhausted/i.test(diagnostic.message ?? "")
  ) {
    return true;
  }

  const points = asRecord(diagnostic.pointsInfo);
  const remaining = Number(points.remaining);
  const messageIsThrottle = /qps limit|too many requests/i.test(diagnostic.message ?? "");
  return messageIsThrottle && Number.isFinite(remaining) && remaining <= 0;
}

/** Use a conservative cooldown because CJ's quota reset timezone is not guaranteed. */
export function getCJQuotaCooldownUntil(nowMs = Date.now()): string {
  return new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
}
