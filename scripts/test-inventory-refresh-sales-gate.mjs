import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const persistence = readFileSync(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8");
assert.match(persistence, /price_checked_at:\s*null/, "cached or caller-provided CJ cost must not be stamped as a fresh price observation");
assert.doesNotMatch(persistence, /price_checked_at:\s*Number\.isFinite\(args\.cost\)/, "price freshness must not be inferred from cost validity alone");

console.log(`Inventory refresh sales-gate invariant: ${cases.length} cases passed; supplier price freshness fail-closed: 2 assertions passed`);
