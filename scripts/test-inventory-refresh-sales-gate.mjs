import assert from "node:assert/strict";
import { hasDurableSalesTestGate } from "../lib/suppliers/inventory-refresh-gate.ts";

const marker = "sales_test_gate_passed";
const cases = [
  { name: "marker_present", input: [marker, "other"], expected: true },
  { name: "empty_reasons", input: [], expected: false },
  { name: "missing_reasons", input: null, expected: false },
  { name: "non_array_reasons", input: marker, expected: false },
  { name: "marker_removed_after_cost_change", input: ["other"], expected: false },
  { name: "wrong_marker", input: ["sales_test_gate_pending"], expected: false },
];
for (const item of cases) {
  assert.equal(hasDurableSalesTestGate(item.input), item.expected, item.name);
}
console.log(`Inventory refresh sales-gate invariant: ${cases.length} cases passed`);
