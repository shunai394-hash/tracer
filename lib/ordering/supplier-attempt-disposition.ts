export type SupplierAttemptDisposition = "created" | "explicit_rejection" | "ambiguous" | "payment_pending" | "tracking_pending";

const AMBIGUOUS_CODES = new Set(["", "EXCEPTION", "TIMEOUT", "ATTEMPT_RECORD_PARTIAL"]);

/**
 * Existing supplier_order_attempts.state allows only in_progress, completed,
 * and unknown. Explicit rejection is completed + succeeded false + a response
 * code. Unknown stays unknown and must not be reordered. A new state value
 * would fail the production check constraint until a migration is applied.
 */
export function classifyCreateOrderResult(result: {
  succeeded: boolean;
  supplierOrderId: string | null;
  responseCode: string | null;
}): { state: "completed" | "unknown"; succeeded: boolean; disposition: SupplierAttemptDisposition } {
  const orderId = typeof result.supplierOrderId === "string" && result.supplierOrderId.trim() ? result.supplierOrderId.trim() : null;
  const code = typeof result.responseCode === "string" ? result.responseCode.trim() : "";
  if (result.succeeded && orderId) {
    return { state: "completed", succeeded: true, disposition: "created" };
  }
  if (!result.succeeded && !orderId && code && !AMBIGUOUS_CODES.has(code.toUpperCase()) && !/timeout/i.test(code)) {
    return { state: "completed", succeeded: false, disposition: "explicit_rejection" };
  }
  return { state: "unknown", succeeded: false, disposition: "ambiguous" };
}

export function classifyStoredAttempt(attempt: {
  state?: unknown;
  succeeded?: unknown;
  supplier_order_id?: unknown;
  response_code?: unknown;
} | null): "resume" | "dedupe" | "explicit_rejection" | "unknown" {
  if (!attempt) return "resume";
  if (attempt.state === "unknown") return "unknown";
  const orderId = typeof attempt.supplier_order_id === "string" && attempt.supplier_order_id.trim() ? attempt.supplier_order_id.trim() : null;
  if (orderId) return "dedupe";
  if (attempt.state === "completed" && attempt.succeeded === false) {
    const classified = classifyCreateOrderResult({
      succeeded: false,
      supplierOrderId: null,
      responseCode: typeof attempt.response_code === "string" ? attempt.response_code : null,
    });
    return classified.disposition === "explicit_rejection" ? "explicit_rejection" : "unknown";
  }
  if (attempt.state === "completed") return "unknown";
  return "resume";
}
