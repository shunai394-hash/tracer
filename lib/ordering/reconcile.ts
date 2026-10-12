import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter } from "@/lib/procurement/registry";

type ReconcileResult = {
  processed: number;
  updated: number;
  failed: number;
  purchaseOrderIds: string[];
  failedPurchaseOrderIds: string[];
  failureDetails: Array<{ purchaseOrderId: string; stage: string; reason: string }>;
};

function normalizeStatus(value: string | null | undefined): string | null {
  const s = value?.trim().toLowerCase();
  if (!s) return null;
  if (["created", "pending", "queued", "processing", "in_progress"].includes(s)) return s === "created" ? "created" : "processing";
  if (["shipped", "in_transit", "fulfilled"].includes(s)) return "shipped";
  if (["delivered", "completed"].includes(s)) return "delivered";
  if (["cancelled", "canceled"].includes(s)) return "cancelled";
  if (["failed", "error", "rejected"].includes(s)) return "failed";
  return s;
}

/**
 * Supplier reconciliation pass.
 *
 * Existing supplier orders are looked up only; this function never creates or
 * resends supplier orders. Payment-recovery rows require explicit payment
 * evidence before their local state is promoted.
 */
export async function reconcileSupplierOrders(limit = 50): Promise<ReconcileResult> {
  initializeProcurement();
  const supabase = createSupabaseAdminClient();

  const { data: purchaseOrders, error } = await supabase
    .from("purchase_orders")
    .select("id,supplier_name,supplier_order_id,status,fulfillment_kind,metadata")
    .not("supplier_order_id", "is", null)
    .in("status", ["placed", "processing", "shipped", "delivered", "supplier_payment_pending", "supplier_payment_verification_failed"])
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));

  if (error) throw new Error(error.message);

  let updated = 0;
  let failed = 0;
  const purchaseOrderIds: string[] = [];
  const failedPurchaseOrderIds: string[] = [];
  const failureDetails: Array<{ purchaseOrderId: string; stage: string; reason: string }> = [];

  for (const po of purchaseOrders ?? []) {
    const purchaseOrderId = String(po.id);
    const supplierName = String(po.supplier_name ?? "").trim();
    const supplierOrderId = String(po.supplier_order_id ?? "").trim();
    const adapter = supplierName && supplierOrderId ? getSupplierAdapter(supplierName) : null;

    if (!adapter) {
      failed += 1;
      failedPurchaseOrderIds.push(purchaseOrderId);
      failureDetails.push({
        purchaseOrderId,
        stage: "supplier_adapter_lookup",
        reason: "supplier_adapter_unavailable",
      });
      console.error("[TRACER SUPPLIER RECONCILIATION]", {
        purchaseOrderId,
        stage: "supplier_adapter_lookup",
        reason: "supplier_adapter_unavailable",
      });
      continue;
    }

    const currentStatus = String(po.status ?? "");
    if (currentStatus === "supplier_payment_pending" || currentStatus === "supplier_payment_verification_failed") {
      // Recovery for an existing supplier order is lookup-only. Never call
      // executeSupplierPurchaseOrder here: an unknown payment outcome must not
      // create or resend a supplier order.
      let stage = "supplier_payment_status_lookup";
      try {
        const paymentResult = await adapter.getOrderStatus(supplierOrderId);
        const paymentConfirmed = paymentResult?.paymentConfirmed === true;
        const observedAt = new Date().toISOString();
        const previousMetadata = (po.metadata as Record<string, unknown> | null) ?? {};
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
          stage = "supplier_payment_attempt_ledger_update";
          const { data: attempt, error: attemptError } = await supabase
            .from("supplier_order_attempts")
            .update({
              succeeded: true,
              response_code: "SUPPLIER_PAYMENT_CONFIRMED",
              response_message: "Supplier payment confirmed by read-only reconciliation",
              state: "completed",
            })
            .eq("purchase_order_id", purchaseOrderId)
            .eq("supplier_order_id", supplierOrderId)
            .select("id")
            .maybeSingle();
          if (attemptError) throw new Error(attemptError.message);
          if (!attempt) throw new Error("supplier_order_attempt_ledger_missing_manual_reconciliation_required");

          stage = "supplier_payment_purchase_order_update";
          const { error: paymentUpdateError } = await supabase
            .from("purchase_orders")
            .update({
              status: "placed",
              supplier_status: "paid",
              supplier_synced_at: observedAt,
              metadata: paymentMetadata,
            })
            .eq("id", purchaseOrderId)
            .in("status", ["supplier_payment_pending", "supplier_payment_verification_failed"]);
          if (paymentUpdateError) throw new Error(paymentUpdateError.message);
        } else {
          stage = "supplier_payment_pending_evidence_update";
          const { error: pendingUpdateError } = await supabase
            .from("purchase_orders")
            .update({
              status: "supplier_payment_pending",
              supplier_status: paymentResult?.status ?? "payment_pending",
              supplier_synced_at: observedAt,
              metadata: paymentMetadata,
            })
            .eq("id", purchaseOrderId)
            .in("status", ["supplier_payment_pending", "supplier_payment_verification_failed"]);
          if (pendingUpdateError) throw new Error(pendingUpdateError.message);
        }

        updated += 1;
        purchaseOrderIds.push(purchaseOrderId);
      } catch (error) {
        failed += 1;
        failedPurchaseOrderIds.push(purchaseOrderId);
        const reason = error instanceof Error ? error.message : String(error);
        failureDetails.push({ purchaseOrderId, stage, reason });
        console.error("[TRACER SUPPLIER PAYMENT RECOVERY]", { purchaseOrderId, stage, reason });
      }
      continue;
    }

    let stage = "supplier_status_lookup";
    try {
      const [statusResult, trackingResult] = await Promise.all([
        adapter.capabilities.orderStatus
          ? adapter.getOrderStatus(supplierOrderId)
          : Promise.resolve(null),
        adapter.capabilities.tracking
          ? adapter.getTracking(supplierOrderId)
          : Promise.resolve(null),
      ]);

      const supplierStatus = normalizeStatus(statusResult?.status);
      const nextStatus =
        supplierStatus === "processing" ||
        supplierStatus === "shipped" ||
        supplierStatus === "delivered" ||
        supplierStatus === "failed" ||
        supplierStatus === "cancelled"
          ? supplierStatus
          : String(po.status);

      const metadata = {
        ...((po.metadata as Record<string, unknown> | null) ?? {}),
        reconciliation: {
          last_status: statusResult?.status ?? null,
          observed_at: new Date().toISOString(),
        },
      };

      const update: Record<string, unknown> = {
        status: nextStatus,
        supplier_status: statusResult?.status ?? null,
        supplier_synced_at: new Date().toISOString(),
        metadata,
      };

      if (trackingResult) {
        update.tracking_carrier = trackingResult.carrier;
        update.tracking_url = trackingResult.trackingUrl;
        update.shipped_at = trackingResult.shippedAt;
      }

      stage = "purchase_order_status_update";
      const { error: updateError } = await supabase
        .from("purchase_orders")
        .update(update)
        .eq("id", purchaseOrderId);

      if (updateError) throw new Error(updateError.message);

      if (supplierName.toLowerCase() === "tracer_internal") {
        stage = "internal_fulfillment_status_update";
        const internalStatus =
          nextStatus === "delivered" ? "delivered" :
          nextStatus === "shipped" ? "shipped" :
          nextStatus === "processing" ? "processing" :
          nextStatus === "failed" ? "failed" :
          nextStatus === "cancelled" ? "cancelled" :
          "reserved";

        const { data: internalOrder, error: internalUpdateError } = await supabase
          .from("internal_fulfillment_orders")
          .update({
            status: internalStatus,
            tracking_number: trackingResult?.trackingNumber ?? null,
            carrier: trackingResult?.carrier ?? null,
            tracking_url: trackingResult?.trackingUrl ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("purchase_order_id", purchaseOrderId)
          .select("id")
          .maybeSingle();

        if (internalUpdateError) throw new Error(internalUpdateError.message);
        if (!internalOrder) throw new Error("internal_fulfillment_order_not_found");
      }

      stage = "complete";
      updated += 1;
      purchaseOrderIds.push(purchaseOrderId);
    } catch (error) {
      failed += 1;
      failedPurchaseOrderIds.push(purchaseOrderId);
      const reason = error instanceof Error ? error.message : String(error);
      failureDetails.push({ purchaseOrderId, stage, reason });
      console.error("[TRACER SUPPLIER RECONCILIATION]", {
        purchaseOrderId,
        stage,
        reason,
      });
    }
  }

  return {
    processed: purchaseOrders?.length ?? 0,
    updated,
    failed,
    purchaseOrderIds,
    failedPurchaseOrderIds,
    failureDetails,
  };
}
