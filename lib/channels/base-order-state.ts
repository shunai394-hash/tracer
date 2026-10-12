const PROTECTED_BASE_ORDER_STATUSES = new Set([
  "cancellation_requested",
  "refund_pending",
  "cancelled",
  "refunded",
]);

export function shouldPreserveBaseOrderState(
  orderStatus: unknown,
  paymentStatus: unknown,
): boolean {
  return (
    PROTECTED_BASE_ORDER_STATUSES.has(String(orderStatus ?? "")) ||
    String(paymentStatus ?? "") === "refunded"
  );
}
