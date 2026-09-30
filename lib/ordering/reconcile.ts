import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter } from "@/lib/procurement/registry";

type ReconcileResult = {
  processed: number;
  updated: number;
  failed: number;
  purchaseOrderIds: string[];
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

  for (const po of purchaseOrders ?? []) {
    const purchaseOrderId = String(po.id);
    const supplierName = String(po.supplier_name ?? "").trim();
    const supplierOrderId = String(po.supplier_order_id ?? "").trim();
    const adapter = supplierName && supplierOrderId ? getSupplierAdapter(supplierName) : null;

    if (!adapter) {
      failed += 1;
      continue;
    }

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

      const { error: updateError } = await supabase
        .from("purchase_orders")
        .update(update)
        .eq("id", purchaseOrderId);

      if (updateError) throw new Error(updateError.message);

      if (supplierName.toLowerCase() === "tracer_internal") {
        const internalStatus =
          nextStatus === "delivered" ? "delivered" :
          nextStatus === "shipped" ? "shipped" :
          nextStatus === "processing" ? "processing" :
          nextStatus === "failed" ? "failed" :
          nextStatus === "cancelled" ? "cancelled" :
          "reserved";

        await supabase
          .from("internal_fulfillment_orders")
          .update({
            status: internalStatus,
            tracking_number: trackingResult?.trackingNumber ?? null,
            carrier: trackingResult?.carrier ?? null,
            tracking_url: trackingResult?.trackingUrl ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("purchase_order_id", purchaseOrderId);
      }

      updated += 1;
      purchaseOrderIds.push(purchaseOrderId);
    } catch (error) {
      failed += 1;
      console.error("[TRACER SUPPLIER RECONCILIATION]", purchaseOrderId, error);
    }
  }

  return {
    processed: purchaseOrders?.length ?? 0,
    updated,
    failed,
    purchaseOrderIds,
  };
}
