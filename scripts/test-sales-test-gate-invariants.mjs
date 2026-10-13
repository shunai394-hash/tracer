import assert from "node:assert/strict";
import { verifySalesTestGateInvariants } from "../lib/market/sales-test-gate.ts";
import { verifyWomenPriorityInvariants } from "../lib/intelligence/womens-priority.ts";
import { verifyProfitInvariants } from "../lib/intelligence/simulate-profit.ts";

const checks = [
  ["sales test gate", verifySalesTestGateInvariants()],
  ["women's product priority", verifyWomenPriorityInvariants()],
  ["fully costed profit", verifyProfitInvariants()],
];
for (const [name, result] of checks) {
  const failed = result.cases.filter((item) => item.actual !== item.expected);
  assert.equal(result.ok, true, `${name} invariants failed: ${JSON.stringify(failed)}`);
  console.log(`${name} invariants: ${result.cases.length} cases passed`);
}
