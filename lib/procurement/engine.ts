import "server-only";

import {
  getSupplierAdapter,
} from "@/lib/procurement/registry";

import type {
  SupplierOrderInput,
  SupplierOrderResult,
} from "@/lib/procurement/types";

export async function executeProcurementOrder(
  supplierName: string,
  input: SupplierOrderInput,
): Promise<SupplierOrderResult> {
  const adapter = getSupplierAdapter(supplierName);

  if (!adapter) {
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "SUPPLIER_NOT_REGISTERED",
      responseMessage: `Supplier adapter is not registered: ${supplierName}`,
      trackingNumber: null,
      raw: null,
    };
  }

  // Never execute a live supplier order from this low-level helper.
  // All live supplier side effects must pass through executeSupplierPurchaseOrder,
  // which performs live refresh, kill-switch, inventory, profitability, idempotency,
  // approval/auto-ordering, and outcome reconciliation before calling the adapter.
  void input;
  return {
    succeeded: false,
    dryRun: true,
    supplierOrderId: null,
    responseCode: "PURCHASE_ORDER_GATE_REQUIRED",
    responseMessage: "Live supplier execution must use executeSupplierPurchaseOrder.",
    trackingNumber: null,
    raw: null,
  };
}
