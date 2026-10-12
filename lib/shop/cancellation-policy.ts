export type CancellationPurchaseOrder = {
  id: string;
  supplier_order_id?: string | null;
  status?: string | null;
};

export type CancellationSupplierAttempt = {
  purchase_order_id: string;
  supplier_order_id?: string | null;
  state?: string | null;
};

export function assessSupplierExecutionRisk(
  purchaseOrders: CancellationPurchaseOrder[],
  attempts: CancellationSupplierAttempt[],
): { supplierOrderPlaced: boolean; supplierExecutionUncertain: boolean } {
  const supplierOrderPlaced = purchaseOrders.some((po) => Boolean(po.supplier_order_id)) ||
    attempts.some((attempt) => Boolean(attempt.supplier_order_id));
  const supplierExecutionUncertain = attempts.some((attempt) =>
    ["in_progress", "unknown"].includes(String(attempt.state)),
  ) || purchaseOrders.some((po) =>
    ["supplier_payment_pending", "supplier_payment_verification_failed"].includes(String(po.status)),
  );
  return { supplierOrderPlaced, supplierExecutionUncertain };
}

export function isCancellationTerminalStatus(status: string): boolean {
  return ["refund_pending", "cancelled", "refunded"].includes(status);
}
