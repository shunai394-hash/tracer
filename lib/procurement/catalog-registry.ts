import "server-only";

import type { ProcurementCatalog } from "@/lib/procurement/catalog";

const catalogs = new Map<string, ProcurementCatalog>();

export function registerProcurementCatalog(
  catalog: ProcurementCatalog,
): void {
  catalogs.set(catalog.name, catalog);
}

export function getProcurementCatalog(
  catalogName: string,
): ProcurementCatalog | null {
  return catalogs.get(catalogName) ?? null;
}

export function listProcurementCatalogs(): string[] {
  return Array.from(catalogs.keys());
}
