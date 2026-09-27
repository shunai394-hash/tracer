import "server-only";

import {
  getProcurementCatalog,
} from "@/lib/procurement/catalog-registry";

import type {
  ProcurementProduct,
  ProcurementProductQuery,
} from "@/lib/procurement/catalog";

export async function searchProcurementProducts(
  catalogName: string,
  query: ProcurementProductQuery,
): Promise<ProcurementProduct[]> {
  const catalog = getProcurementCatalog(catalogName);

  if (!catalog) {
    return [];
  }

  return catalog.search(query);
}

export async function getProcurementProduct(
  catalogName: string,
  supplierProductId: string,
): Promise<ProcurementProduct | null> {
  const catalog = getProcurementCatalog(catalogName);

  if (!catalog) {
    return null;
  }

  return catalog.getProduct(supplierProductId);
}
