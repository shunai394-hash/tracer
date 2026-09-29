import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import { initializeProcurement } from "@/lib/procurement/init";

export type SupplierOrderSyncResult = {
  inspected: number;
  updated: number;
  trackingUpdated: number;
  blocked: number;
  errors: number;
};

function normalizeSupplierOrderStatus(supplier: string, rawStatus: string | null): string | null {
  if (!rawStatus) return null;
  const status = rawStatus.trim().toUpperCase();
  if (supplier.toLowerCase() === "cj") {
    switch (status) {
      case "CREATED":
      case "IN_CART":
      case "UNPAID":
      case "PENDING":
      case "PROCESSING":
      case "UNSHIPPED":
        return "supplier_processing";
      case "SHIPPED":
        return "shipping";
      case "DELIVERED":
        return "delivered";
      case "CANCELLED":
      case "CANCELED":
        return "canceled";
      default:
        return null;
    }
  }
  return null;
}

export async function syncSupplierOrders(): Promise<SupplierOrderSyncResult> {
  initializeProcurement();
  const supabase = createSupabaseAdminClient();
  const result: SupplierOrderSyncResult = {
    inspected: 0,
    updated: 0,
    trackingUpdated: 0,
    blocked: 0,
    errors: 0,
  };

  const { data: purchaseOrders, error } = await supabase
    .from("purchase_orders")
    .select("*")
    .not("supplier_order_id", "is", null)
    .in("status", ["placed", "supplier_processing", "shipping"])
    .order("updated_at", { ascending: true })
    .limit(100);

  if (error) throw new Error(error.message);

  for (const purchaseOrder of purchaseOrders ?? []) {
    result.inspected += 1;
    const supplierName = String(purchaseOrder.supplier_name ?? "");
    const supplierOrderId = String(purchaseOrder.supplier_order_id ?? "");
    const adapter = getSupplierAdapter(supplierName);

    if (!adapter || !supplierOrderId) {
      result.blocked += 1;
      await supabase
        .from("purchase_orders")
        .update({
          metadata: {
            ...(purchaseOrder.metadata as Record<string, unknown>),
            tracking_sync_error: "supplier_adapter_not_registered",
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", purchaseOrder.id);
      continue;
    }

    try {
      const status = await adapter.getOrderStatus(supplierOrderId);
      const tracking = await adapter.getTracking(supplierOrderId);
      const now = new Date().toISOString();
      const supplierStatus = String(status?.status ?? "").trim().toUpperCase();
      const update: Record<string, unknown> = {
        supplier_status: status?.status ?? null,
        supplier_synced_at: now,
        updated_at: now,
      };

      // Keep TRACER's fulfillment state aligned with CJ's documented lifecycle.
      // CREATED/IN_CART/UNPAID/PENDING/PROCESSING/UNSHIPPED are still supplier-side
      // processing; SHIPPED/DELIVERED/CANCELLED are terminal or shipping states.
      if (["CREATED", "IN_CART", "UNPAID", "PENDING", "PROCESSING", "UNSHIPPED"].includes(supplierStatus)) {
        update.status = "supplier_processing";
      } else if (supplierStatus === "SHIPPED") {
        update.status = "shipping";
      } else if (supplierStatus === "DELIVERED") {
        update.status = "delivered";
      } else if (supplierStatus === "CANCELLED") {
        update.status = "cancelled";
      }

      if (tracking?.trackingNumber) {
        update.tracking_number = tracking.trackingNumber;
        update.tracking_carrier = tracking.carrier;
        update.tracking_url = tracking.trackingUrl;
        update.shipped_at = tracking.shippedAt ?? now;
        if (supplierStatus !== "DELIVERED" && supplierStatus !== "CANCELLED") {
          update.status = "shipping";
        }
        result.trackingUpdated += 1;
      }

      const { error: updateError } = await supabase
        .from("purchase_orders")
        .update(update)
        .eq("id", purchaseOrder.id);
      if (updateError) throw new Error(updateError.message);

      if (purchaseOrder.shop_order_id) {
        const shopUpdate: Record<string, unknown> = {};
        if (tracking?.trackingNumber) {
          shopUpdate.tracking_number = tracking.trackingNumber;
          shopUpdate.tracking_carrier = tracking.carrier;
          shopUpdate.tracking_url = tracking.trackingUrl;
          shopUpdate.shipped_at = tracking.shippedAt ?? now;
        }
        if (supplierStatus === "SHIPPED" || tracking?.trackingNumber) shopUpdate.order_status = "shipping";
        if (supplierStatus === "DELIVERED") shopUpdate.order_status = "delivered";
        if (supplierStatus === "CANCELLED") shopUpdate.order_status = "cancelled";
        if (Object.keys(shopUpdate).length > 0) {
          const { error: shopOrderError } = await supabase
            .from("shop_orders")
            .update(shopUpdate)
            .eq("id", purchaseOrder.shop_order_id);
          if (shopOrderError) throw new Error(shopOrderError.message);
        }
      }

      result.updated += 1;
    } catch (syncError) {
      result.errors += 1;
      await supabase
        .from("purchase_orders")
        .update({
          metadata: {
            ...(purchaseOrder.metadata as Record<string, unknown>),
            tracking_sync_error:
              syncError instanceof Error ? syncError.message : String(syncError),
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", purchaseOrder.id);
    }
  }

  return result;
}
