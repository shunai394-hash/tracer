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

  return adapter.createOrder(input);
}
