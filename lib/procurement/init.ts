import "server-only";

import { registerSupplierAdapter } from "@/lib/procurement/registry";
import { tracerTestSupplier } from "@/lib/procurement/test-supplier";
import { faireSupplierAdapter } from "@/lib/procurement/faire-adapter";
import { dsersSupplierAdapter } from "@/lib/procurement/dsers-adapter";
import { tracerInternalSupplierAdapter } from "@/lib/procurement/tracer-internal-adapter";
import { shopifyCollectiveSupplierAdapter } from "@/lib/procurement/shopify-collective-adapter";

let initialized = false;

export function initializeProcurement(): void {
  if (initialized) {
    return;
  }

  registerSupplierAdapter(tracerTestSupplier);
  registerSupplierAdapter(faireSupplierAdapter);
  registerSupplierAdapter(dsersSupplierAdapter);
  registerSupplierAdapter(tracerInternalSupplierAdapter);
  registerSupplierAdapter(shopifyCollectiveSupplierAdapter);
  initialized = true;
}

