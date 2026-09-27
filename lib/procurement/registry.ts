import "server-only";

import type { TracerSupplierAdapter } from "@/lib/procurement/types";

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
