import { SALES_TEST_GATE_PASSED } from "../market/sales-test-gate.ts";

/** Inventory refresh may restore availability only while the durable sales-test marker remains. */
export function hasDurableSalesTestGate(selectionReasons: unknown): boolean {
  return Array.isArray(selectionReasons)
    && selectionReasons.some((reason) => String(reason) === SALES_TEST_GATE_PASSED);
}
