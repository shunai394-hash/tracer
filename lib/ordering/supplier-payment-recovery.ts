export type SupplierPaymentStatusResult = {
  status?: string | null;
  paymentConfirmed?: boolean | null;
};

type PersistResult<T> = { data?: T | null; error?: { message: string } | null };

export type SupplierPaymentRecoveryDependencies = {
  orderStatusSupported: boolean;
  lookupOrderStatus: (supplierOrderId: string) => Promise<SupplierPaymentStatusResult | null>;
  updateAttempt: (purchaseOrderId: string, supplierOrderId: string) => Promise<PersistResult<{ id: string }>>;
  updatePurchaseOrder: (
    purchaseOrderId: string,
    allowedStatuses: string[],
    patch: Record<string, unknown>,
  ) => Promise<PersistResult<{ id: string }>>;
  setStage?: (stage: string) => void;
  now?: () => string;
};

/** Existing supplier orders are looked up only; this recovery path never creates or resends supplier orders. */
export async function recoverSupplierPaymentState(args: {
  purchaseOrderId: string;
  supplierOrderId: string;
  currentMetadata: Record<string, unknown> | null;
  dependencies: SupplierPaymentRecoveryDependencies;
}): Promise<{ status: "placed" | "supplier_payment_pending"; supplierStatus: string; observedAt: string }> {
  const { purchaseOrderId, supplierOrderId, currentMetadata, dependencies } = args;
  const stage = (value: string) => dependencies.setStage?.(value);
  if (!dependencies.orderStatusSupported) {
    stage("supplier_payment_status_lookup");
    throw new Error("supplier_payment_status_lookup_unsupported_manual_reconciliation_required");
  }

  stage("supplier_payment_status_lookup");
  const paymentResult = await dependencies.lookupOrderStatus(supplierOrderId);
  const paymentConfirmed = paymentResult?.paymentConfirmed === true;
  const observedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const previousMetadata = currentMetadata ?? {};
  const previousPayment = (previousMetadata.supplier_payment as Record<string, unknown> | undefined) ?? {};
  const paymentMetadata = {
    ...previousMetadata,
    supplier_payment: {
      ...previousPayment,
      confirmed: paymentConfirmed,
      supplier_order_id: supplierOrderId,
      supplier_status: paymentResult?.status ?? null,
      verified_at: observedAt,
      verification_error: null,
      recovery_source: "supplier_status_reconciliation",
    },
  };

  if (paymentConfirmed) {
    stage("supplier_payment_attempt_ledger_update");
    const attempt = await dependencies.updateAttempt(purchaseOrderId, supplierOrderId);
    if (attempt.error) throw new Error(attempt.error.message);
    if (!attempt.data) throw new Error("supplier_order_attempt_ledger_missing_manual_reconciliation_required");

    stage("supplier_payment_purchase_order_update");
    const persisted = await dependencies.updatePurchaseOrder(purchaseOrderId,
      ["supplier_payment_pending", "supplier_payment_verification_failed"], {
        status: "placed",
        supplier_status: "paid",
        supplier_synced_at: observedAt,
        metadata: paymentMetadata,
      });
    if (persisted.error) throw new Error(persisted.error.message);
    if (!persisted.data) throw new Error("supplier_payment_purchase_order_update_conflict_manual_reconciliation_required");
    return { status: "placed", supplierStatus: "paid", observedAt };
  }

  stage("supplier_payment_pending_evidence_update");
  const supplierStatus = paymentResult?.status ?? "payment_pending";
  const persisted = await dependencies.updatePurchaseOrder(purchaseOrderId,
    ["supplier_payment_pending", "supplier_payment_verification_failed"], {
      status: "supplier_payment_pending",
      supplier_status: supplierStatus,
      supplier_synced_at: observedAt,
      metadata: paymentMetadata,
    });
  if (persisted.error) throw new Error(persisted.error.message);
  if (!persisted.data) throw new Error("supplier_payment_pending_update_conflict_manual_reconciliation_required");
  return { status: "supplier_payment_pending", supplierStatus, observedAt };
}
