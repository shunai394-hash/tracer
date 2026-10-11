import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyOrderGateInvariants } from "../lib/ordering/gates.ts";

const gates = await readFile(new URL("../lib/ordering/gates.ts", import.meta.url), "utf8");

assert.match(gates, /forecastProfit30d === null/, "unknown forecast profit must be blocked");
assert.match(gates, /forecastProfit30d <= 0/, "zero or negative forecast profit must be blocked");
assert.match(gates, /sourceCost <= 0/, "zero or negative source cost must be blocked");
assert.match(gates, /estimatedCost <= 0/, "zero or negative estimated order cost must be blocked");
assert.match(gates, /Number\.isFinite\(input\.estimatedCost\)/, "non-finite estimated order cost must be blocked");
assert.match(gates, /name: "non_positive_profit_blocks_order"/, "zero-profit regression case must remain in the invariant suite");
assert.match(gates, /name: "zero_source_cost_blocks_order"/, "zero-source-cost regression case must remain in the invariant suite");
assert.match(gates, /name: "unknown_profit_blocks_auto"/, "unknown-profit regression case must remain in the invariant suite");

const invariants = verifyOrderGateInvariants();
const failures = invariants.cases.filter((item) => item.actual !== item.expected);
assert.equal(invariants.ok, true, `Order gate invariant failures: ${JSON.stringify(failures)}`);
for (const name of [
  "invalid_estimated_cost_zero_blocks_order",
  "invalid_estimated_cost_negative_blocks_order",
  "invalid_estimated_cost_nan_blocks_order",
  "invalid_estimated_cost_infinity_blocks_order",
]) {
  assert.ok(invariants.cases.some((item) => item.name === name && item.actual === true), `${name} must pass`);
}

console.log(`Order gate fail-closed checks: ${invariants.cases.length} behavioral invariants passed; source guards passed`);
