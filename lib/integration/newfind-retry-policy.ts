const RETRYABLE_REJECTED_NEWFIND_EVENTS = new Set([
  "decorative_craft_object_not_promoted",
  "discovery product missing",
  "discovery product missing after accepted tracer event",
]);

/**
 * These errors are rejected by the receiver before durable promotion. After
 * the receiver fixes a gate/schema bug, the old event ID remains permanently
 * rejected by its inbox, so a retry must use a fresh idempotency key. The
 * receiver's product URL and TRACER listing ID remain the canonical dedupe keys.
 */
export function isRetryableRejectedNewfindEvent(error: unknown): boolean {
  return typeof error === "string"
    && RETRYABLE_REJECTED_NEWFIND_EVENTS.has(error.trim().toLowerCase());
}
