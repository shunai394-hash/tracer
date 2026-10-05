import "server-only";

import { FAIL_CLOSED_SUPPLIER_CAPABILITIES, type SupplierCapabilities, type TracerSupplierAdapter } from "@/lib/procurement/types";

const adapters = new Map<string, TracerSupplierAdapter>();

export function registerSupplierAdapter(
  adapter: TracerSupplierAdapter,
): void {
  adapters.set(adapter.name, adapter);
}

function normalizeSupplierName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "cjdropshipping" || normalized === "cj dropshipping") return "cj";
  return normalized;
}

export function getSupplierAdapter(
  supplierName: string,
): TracerSupplierAdapter | null {
  return adapters.get(normalizeSupplierName(supplierName)) ?? null;
}

export function listSupplierAdapters(): string[] {
  return Array.from(adapters.keys());
}

export function getSupplierCapabilities(
  supplierName: string,
): SupplierCapabilities {
  return getSupplierAdapter(supplierName)?.capabilities ?? FAIL_CLOSED_SUPPLIER_CAPABILITIES;
}
