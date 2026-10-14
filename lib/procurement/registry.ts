import "server-only";

import { FAIL_CLOSED_SUPPLIER_CAPABILITIES, type SupplierCapabilities, type TracerSupplierAdapter } from "@/lib/procurement/types";
import { initializeProcurement } from "@/lib/procurement/init";

const adapters = new Map<string, TracerSupplierAdapter>();

export function registerSupplierAdapter(
  adapter: TracerSupplierAdapter,
): void {
  const normalized = normalizeSupplierName(adapter.name);
  // Supplier adapters are admitted by registration, then independently gated
  // by capability checks and explicit live/auto-order settings at execution time.
  // Keep only the separately excluded Superdelivery integration out of the registry.
  if (normalized === "superdelivery" || normalized === "super delivery") return;
  adapters.set(normalized, adapter);
}

function normalizeSupplierName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "cjdropshipping" || normalized === "cj dropshipping") return "cj";
  return normalized;
}

export function getSupplierAdapter(
  supplierName: string,
): TracerSupplierAdapter | null {
  if (adapters.size === 0) initializeProcurement();
  return adapters.get(normalizeSupplierName(supplierName)) ?? null;
}

export function listSupplierAdapters(): string[] {
  if (adapters.size === 0) initializeProcurement();
  return Array.from(adapters.keys());
}

export function getSupplierCapabilities(
  supplierName: string,
): SupplierCapabilities {
  if (adapters.size === 0) initializeProcurement();
  return getSupplierAdapter(supplierName)?.capabilities ?? FAIL_CLOSED_SUPPLIER_CAPABILITIES;
}
