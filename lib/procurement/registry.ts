import "server-only";

import type { TracerSupplierAdapter } from "@/lib/procurement/types";

const adapters = new Map<string, TracerSupplierAdapter>();

export function registerSupplierAdapter(
  adapter: TracerSupplierAdapter,
): void {
  adapters.set(adapter.name, adapter);
}

export function getSupplierAdapter(
  supplierName: string,
): TracerSupplierAdapter | null {
  return adapters.get(supplierName) ?? null;
}

export function listSupplierAdapters(): string[] {
  return Array.from(adapters.keys());
}
