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
 * Read-only reconciliation pass.
 *
 * It never creates supplier orders and never fabricates shipment state.
 * Supplier adapters remain the source of truth for supplier status/tracking.
 */
export async function reconcileSupplierOrders(limit = 50): Promise<ReconcileResult> {
  initializeProcurement();
  const supabase = createSupabaseAdminClient();

  const { data: purchaseOrders, error } = await supabase
    .from("purchase_orders")
    .select("id,supplier_name,supplier_order_id,status,fulfillment_kind,metadata")
    .not("supplier_order_id", "is", null)
    .in("status", ["placed", "processing", "shipped", "delivered"])
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
          .select("id,order_number,supply_variant_id,quantity")
          .maybeSingle();

        if (internalUpdateError) throw new Error(internalUpdateError.message);
        if (!internalOrder) throw new Error("internal_fulfillment_order_not_found");

        if (internalStatus === "failed" || internalStatus === "cancelled") {
          stage = "internal_inventory_release";
          const reservationKey = String(internalOrder.order_number ?? "");
          const variantId = String(internalOrder.supply_variant_id ?? "");
          const quantity = Number(internalOrder.quantity);
          const { data: reservation, error: reservationError } = await supabase
            .from("internal_supply_inventory_reservations")
            .select("state")
            .eq("reservation_key", reservationKey)
            .maybeSingle();
          if (reservationError) throw new Error(reservationError.message);
          if (!reservation) throw new Error("internal_inventory_reservation_missing_manual_reconciliation_required");

          if (reservation.state !== "released") {
            const { data: released, error: releaseError } = await supabase.rpc("release_internal_supply_variant", {
              p_reservation_key: reservationKey,
              p_variant_id: variantId,
              p_quantity: quantity,
              p_reason: `supplier_order_${internalStatus}`,
            });
            if (releaseError) throw new Error(releaseError.message);
            if (!released?.length) {
              const { data: reservationAfter, error: reservationAfterError } = await supabase
                .from("internal_supply_inventory_reservations")
                .select("state")
                .eq("reservation_key", reservationKey)
                .maybeSingle();
              if (reservationAfterError) throw new Error(reservationAfterError.message);
              if (reservationAfter?.state !== "released") {
                throw new Error("internal_inventory_release_not_confirmed_manual_reconciliation_required");
              }
            }
          }
        }
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

  // Retry terminal internal-order inventory returns that failed in a prior
  // reconciliation pass. Only terminal orders are eligible; active reservations
  // are never released just because an order row is temporarily unavailable.
  const { data: pendingReservations, error: pendingReservationError } = await supabase
    .from("internal_supply_inventory_reservations")
    .select("reservation_key,variant_id,quantity,state")
    .in("state", ["reserved", "committed"])
    .limit(100);

  if (pendingReservationError) {
    failed += 1;
    failureDetails.push({
      purchaseOrderId: "internal-inventory-return-scan",
      stage: "inventory_return_scan",
      reason: pendingReservationError.message,
    });
    console.error("[TRACER INTERNAL INVENTORY RETURN SCAN FAILED]", {
      error: pendingReservationError.message,
    });
  } else {
    for (const reservation of pendingReservations ?? []) {
      const reservationKey = String(reservation.reservation_key ?? "");
      const { data: internalOrder, error: internalOrderError } = await supabase
        .from("internal_fulfillment_orders")
        .select("purchase_order_id,status")
        .eq("order_number", reservationKey)
        .maybeSingle();
      if (internalOrderError) {
        failed += 1;
        const purchaseOrderId = String(internalOrder?.purchase_order_id ?? reservationKey);
        failedPurchaseOrderIds.push(purchaseOrderId);
        failureDetails.push({ purchaseOrderId, stage: "inventory_return_order_lookup", reason: internalOrderError.message });
        continue;
      }
      if (!internalOrder || !["failed", "cancelled"].includes(String(internalOrder.status))) continue;

      const purchaseOrderId = String(internalOrder.purchase_order_id);
      const { data: released, error: releaseError } = await supabase.rpc("release_internal_supply_variant", {
        p_reservation_key: reservationKey,
        p_variant_id: String(reservation.variant_id),
        p_quantity: Number(reservation.quantity),
        p_reason: `supplier_order_${String(internalOrder.status)}_retry`,
      });
      if (releaseError) {
        failed += 1;
        failedPurchaseOrderIds.push(purchaseOrderId);
        failureDetails.push({ purchaseOrderId, stage: "inventory_return_retry", reason: releaseError.message });
        console.error("[TRACER INTERNAL INVENTORY RETURN RETRY FAILED]", {
          purchaseOrderId,
          reservationKey,
          variantId: reservation.variant_id,
          error: releaseError.message,
        });
        continue;
      }
      if (released?.length) {
        console.info("[TRACER INTERNAL INVENTORY RETURN RETRIED]", {
          purchaseOrderId,
          reservationKey,
          variantId: reservation.variant_id,
          quantity: reservation.quantity,
          status: internalOrder.status,
        });
      }
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
