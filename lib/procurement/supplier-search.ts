import "server-only";

import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import type { ProcurementProduct } from "@/lib/procurement/catalog";

const DISCOVERY_SUPPLIERS = ["orosy", "cj", "faire"] as const;

export async function searchSupplierProducts(
  query: string,
): Promise<ProcurementProduct[]> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return [];
  }

  initializeProcurement();

  const results: ProcurementProduct[] = [];

  for (const supplierName of DISCOVERY_SUPPLIERS) {
    const adapter = getSupplierAdapter(supplierName);
    if (!adapter) continue;

    try {
      const products = await adapter.search(normalizedQuery);
      for (const product of products) {
        results.push({
          supplierProductId: product.supplierProductId,
          supplierName: product.supplierName,
          title: product.title,
          identifier: null,
          currency: product.currency,
          unitCost: product.unitCost,
          shippingCost: product.shippingCost,
          available: product.available,
          orderable: product.orderable,
          trackingAvailable: product.trackingAvailable,
          sourceUrl: null,
        });
      }
    } catch (error) {
      console.warn("[supplier-search] supplier discovery failed; continuing", {
        supplier: supplierName,
        query: normalizedQuery,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
