import "server-only";

import type { ProcurementProduct } from "@/lib/procurement/catalog";

export async function searchSupplierProducts(
  query: string,
): Promise<ProcurementProduct[]> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return [];
  }

  // Supplier catalog adapters are added here.
  // Never fabricate supplier products, prices, inventory, or orderability.
  return [];
}
