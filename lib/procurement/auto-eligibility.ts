import "server-only";

import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter, getSupplierCapabilities } from "@/lib/procurement/registry";

export type AutoProcurementMode =
  | "AUTO"
  | "SEMI_AUTO"
  | "MANUAL"
  | "UNSUPPORTED";

export const AUTO_PROCUREMENT_REQUIRED_CAPABILITIES = [
  "variant",
  "inventory",
  "price",
  "shipping",
  "orderCreation",
  "payment",
  "liveOrdering",
] as const;

export type AutoProcurementEligibility = {
  eligible: boolean;
  supplier: string;
  mode: AutoProcurementMode;
  missing: string[];
  reason: string;
};

export function getAutoProcurementEligibility(
  supplierName: string | null | undefined,
): AutoProcurementEligibility {
  initializeProcurement();

  const supplier = String(supplierName ?? "").trim().toLowerCase();
  if (!supplier) {
    return {
      eligible: false,
      supplier,
      mode: "UNSUPPORTED",
      missing: [...AUTO_PROCUREMENT_REQUIRED_CAPABILITIES],
      reason: "supplier_auto_procurement_capability_missing",
    };
  }

  const adapter = getSupplierAdapter(supplier);
  if (!adapter) {
    return {
      eligible: false,
      supplier,
      mode: "UNSUPPORTED",
      missing: [...AUTO_PROCUREMENT_REQUIRED_CAPABILITIES],
      reason: "supplier_auto_procurement_capability_missing",
    };
  }

  const capabilities = getSupplierCapabilities(supplier);
  const missing = AUTO_PROCUREMENT_REQUIRED_CAPABILITIES.filter(
    (capability) => capabilities[capability] !== true,
  );

  return {
    eligible: missing.length === 0,
    supplier,
    mode: missing.length === 0 ? "AUTO" : "UNSUPPORTED",
    missing: [...missing],
    reason:
      missing.length === 0
        ? "supplier_auto_procurement_ready"
        : "supplier_auto_procurement_capability_missing",
  };
}
