import "server-only";

import { registerSupplierAdapter } from "@/lib/procurement/registry";
import { orosySupplierAdapter } from "@/lib/procurement/orosy-adapter";
import { cjSupplierAdapter } from "@/lib/procurement/cj-adapter";
import { tracerTestSupplier } from "@/lib/procurement/test-supplier";
import { faireSupplierAdapter } from "@/lib/procurement/faire-adapter";

let initialized = false;

export function initializeProcurement(): void {
  if (initialized) {
    return;
  }

  registerSupplierAdapter(tracerTestSupplier);
  registerSupplierAdapter(orosySupplierAdapter);
  registerSupplierAdapter(cjSupplierAdapter);
  registerSupplierAdapter(faireSupplierAdapter);
  initialized = true;
}

