import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import {
  executeSupplierPurchaseOrder,
  type ExecuteSupplierPurchaseOrderResult,
} from "@/lib/ordering/supplier-execution";

/**
 * Supplier execution is not considered successful merely because a supplier
 * order ID exists. The supplier must explicitly report payment completion.
 *
 * This wrapper also re-checks existing/idempotent attempts, so an old attempt
 * cannot be promoted back to purchase_orders.status=placed solely from its ID.
 */
// States that supplier sync sets after a paid order progresses.
const POST_PAYMENT_STATUSES = new Set([
  "processing",
  "supplier_processing",
  "shipping",
  "shipped",
  "delivered",
  "received",
]);

export async function executeVerifiedSupplierPurchaseOrder(
  purchaseOrderId: string,
): Promise<ExecuteSupplierPurchaseOrderResult> {
  const result = await executeSupplierPurchaseOrder(purchaseOrderId);
  if (!result.supplierOrderId) return result;

  const supabase = createSupabaseAdminClient();
  const { data: current, error: currentError } = await supabase
    .from("purchase_orders")
    .select("status,metadata")
    .eq("id", purchaseOrderId)
    .maybeSingle();
  if (currentError) throw new Error(currentError.message);

  const metadata = (current?.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
    ? current.metadata
    : {}) as Record<string, unknown>;
  const recordedPayment = metadata.supplier_payment as { confirmed?: unknown } | undefined;

  // Payment already confirmed and the order has moved on (placed with
  // confirmed payment, or a later fulfilment state set by supplier sync).
  // Re-verifying on every autonomous run must never roll it back to "placed"
  // or discard its recorded evidence.
  const status = String(current?.status ?? "");
  // Terminal outcomes recorded by supplier reconciliation stay terminal.
  if (status === "failed" || status === "cancelled") {
    return { ...result, succeeded: false, reason: `purchase_order_${status}` };
  }
  if (
    POST_PAYMENT_STATUSES.has(status) ||
    (status === "placed" && recordedPayment?.confirmed === true)
  ) {
    return { ...result, succeeded: true, reason: result.reason ?? "supplier_payment_already_confirmed" };
  }

  const adapter = getSupplierAdapter(result.supplierName);
  if (!adapter) {
    return {
      ...result,
      succeeded: false,
      reason: "supplier_adapter_not_registered_for_payment_verification",
    };
  }

  let paymentConfirmed = false;
  let supplierStatus: string | null = null;

  try {
    const supplierOrder = await adapter.getOrderStatus(result.supplierOrderId);
    paymentConfirmed = supplierOrder?.paymentConfirmed === true;
    supplierStatus = supplierOrder?.status ?? null;
  } catch (error) {
    await supabase
      .from("purchase_orders")
      .update({
        status: "supplier_payment_verification_failed",
        supplier_status: "payment_verification_failed",
        supplier_synced_at: new Date().toISOString(),
        metadata: {
          ...metadata,
          supplier_payment: {
            confirmed: false,
            verification_error: error instanceof Error ? error.message : String(error),
            supplier_order_id: result.supplierOrderId,
            verified_at: new Date().toISOString(),
          },
        },
      })
      .eq("id", purchaseOrderId);

    return {
      ...result,
      succeeded: false,
      reason: "supplier_payment_verification_failed_manual_reconciliation_required",
    };
  }

  if (!paymentConfirmed) {
    await supabase
      .from("purchase_orders")
      .update({
        supplier_order_id: result.supplierOrderId,
        live_order: true,
        supplier_status: "payment_pending",
        supplier_synced_at: new Date().toISOString(),
        status: "supplier_payment_pending",
        metadata: {
          ...metadata,
          supplier_payment: {
            confirmed: false,
            supplier_order_id: result.supplierOrderId,
            supplier_status: supplierStatus,
            verified_at: new Date().toISOString(),
          },
        },
      })
      .eq("id", purchaseOrderId);

    await supabase
      .from("supplier_order_attempts")
      .update({
        succeeded: false,
        response_code: "SUPPLIER_PAYMENT_NOT_CONFIRMED",
        response_message: `Supplier order exists but payment is not explicitly confirmed; status=${supplierStatus ?? "unknown"}`,
        state: "completed",
      })
      .eq("purchase_order_id", purchaseOrderId)
      .eq("supplier_order_id", result.supplierOrderId);

    return {
      ...result,
      succeeded: false,
      reason: "supplier_payment_not_confirmed",
    };
  }

  const { error: paymentPersistError } = await supabase
    .from("purchase_orders")
    .update({
      supplier_order_id: result.supplierOrderId,
      live_order: true,
      supplier_status: "paid",
      supplier_synced_at: new Date().toISOString(),
      status: "placed",
      metadata: {
        ...metadata,
        supplier_payment: {
          confirmed: true,
          supplier_order_id: result.supplierOrderId,
          supplier_status: supplierStatus,
          verified_at: new Date().toISOString(),
        },
      },
    })
    .eq("id", purchaseOrderId);

  if (paymentPersistError) {
    return {
      ...result,
      succeeded: false,
      reason: "supplier_payment_confirmation_persist_failed_manual_reconciliation_required",
    };
  }

  await supabase
    .from("supplier_order_attempts")
    .update({
      succeeded: true,
      response_code: "SUPPLIER_PAYMENT_CONFIRMED",
      response_message: `Supplier payment confirmed; status=${supplierStatus ?? "unknown"}`,
      state: "completed",
    })
    .eq("purchase_order_id", purchaseOrderId)
    .eq("supplier_order_id", result.supplierOrderId);

  return {
    ...result,
    succeeded: true,
    reason: null,
  };
}
