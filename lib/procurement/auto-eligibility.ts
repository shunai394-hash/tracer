import "server-only";

import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierCapabilities } from "@/lib/procurement/registry";
import type { SupplierCapabilities } from "@/lib/procurement/types";

const REQUIRED_AUTO_CAPABILITIES = [
  "variant",
  "inventory",
  "price",
  "shipping",
  "orderCreation",
  "payment",
  "liveOrdering",
] as const satisfies readonly (keyof SupplierCapabilities)[];

export type SupplierAutoEligibility = {
  eligible: boolean;
  supplier: string;
  mode: "AUTO" | "UNSUPPORTED";
  missing: Array<(typeof REQUIRED_AUTO_CAPABILITIES)[number]>;
  reason: string;
  capabilities: SupplierCapabilities;
};

export function evaluateSupplierAutoEligibility(
  supplierName: string,
): SupplierAutoEligibility {
  initializeProcurement();

  const supplier = supplierName.trim().toLowerCase();
  const capabilities = getSupplierCapabilities(supplier);
  const missing = REQUIRED_AUTO_CAPABILITIES.filter(
    (key) => capabilities[key] !== true,
  );
  const eligible = missing.length === 0;

  return {
    eligible,
    supplier,
    mode: eligible ? "AUTO" : "UNSUPPORTED",
    missing: [...missing],
    reason: eligible
      ? "supplier_auto_procurement_capability_verified"
      : "supplier_auto_procurement_capability_missing",
    capabilities,
  };
}

export { REQUIRED_AUTO_CAPABILITIES };
