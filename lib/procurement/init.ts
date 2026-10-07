import "server-only";

import { registerSupplierAdapter } from "@/lib/procurement/registry";
import { orosySupplierAdapter } from "@/lib/procurement/orosy-adapter";
import { tracerTestSupplier } from "@/lib/procurement/test-supplier";
import { faireSupplierAdapter } from "@/lib/procurement/faire-adapter";
import { dsersSupplierAdapter } from "@/lib/procurement/dsers-adapter";
import { tracerInternalSupplierAdapter } from "@/lib/procurement/tracer-internal-adapter";

let initialized = false;

export function initializeProcurement(): void {
  if (initialized) {
    return;
  }

  registerSupplierAdapter(tracerTestSupplier);
  registerSupplierAdapter(orosySupplierAdapter);
  registerSupplierAdapter(faireSupplierAdapter);
  registerSupplierAdapter(dsersSupplierAdapter);
  registerSupplierAdapter(tracerInternalSupplierAdapter);
  initialized = true;
}

