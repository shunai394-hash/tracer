import "server-only";

import { isSupplierDryRunEnabled } from "@/lib/config/env";
import { initializeProcurement } from "@/lib/procurement/init";

import type {
  SupplierOrderInput,
  SupplierOrderResult,
} from "@/lib/procurement/types";

export type ProcurementOrderInput = SupplierOrderInput;

export type ProcurementOrderResult = SupplierOrderResult;

export async function createProcurementOrder(
  input: ProcurementOrderInput,
): Promise<ProcurementOrderResult> {
  if (!input.supplierProductId.trim()) {
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "SUPPLIER_PRODUCT_ID_REQUIRED",
      responseMessage: "supplierProductId is required",
      trackingNumber: null,
      raw: null,
    };
  }

  if (!input.supplierVariantId.trim()) {
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "SUPPLIER_VARIANT_ID_REQUIRED",
      responseMessage: "supplierVariantId is required",
      trackingNumber: null,
      raw: null,
    };
  }

  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "INVALID_QUANTITY",
      responseMessage: "quantity must be greater than zero",
      trackingNumber: null,
      raw: null,
    };
  }

  if (isSupplierDryRunEnabled()) {
    return {
      succeeded: false,
      dryRun: true,
      supplierOrderId: null,
      responseCode: "DRY_RUN",
      responseMessage: "DRY_RUN=true: supplier order was not sent",
      trackingNumber: null,
      raw: {
        supplierName: input.supplierName ?? null,
        orderNumber: input.orderNumber,
        supplierProductId: input.supplierProductId,
        quantity: input.quantity,
        shippingCountryCode: input.shippingCountryCode,
        shippingProvince: input.shippingProvince,
        shippingCity: input.shippingCity,
        shippingZip: input.shippingZip,
      },
    };
  }

  initializeProcurement();

  // Live supplier orders must go through the purchase-order execution gate.
  // This low-level helper is intentionally dry-run only to prevent bypassing
  // kill-switch, inventory, profitability, address, idempotency, and approval checks.
  return {
    succeeded: false,
    dryRun: true,
    supplierOrderId: null,
    responseCode: "PURCHASE_ORDER_GATE_REQUIRED",
    responseMessage: "Live supplier execution must use executeSupplierPurchaseOrder.",
    trackingNumber: null,
    raw: {
      supplierName: input.supplierName ?? null,
      orderNumber: input.orderNumber,
      supplierProductId: input.supplierProductId,
      supplierVariantId: input.supplierVariantId,
      quantity: input.quantity,
    },
  };
}

