import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifySalesTestGateInvariants } from "../lib/market/sales-test-gate.ts";
import { verifyWomenPriorityInvariants } from "../lib/intelligence/womens-priority.ts";

const checks = [
  ["sales test gate", verifySalesTestGateInvariants()],
  ["women's product priority", verifyWomenPriorityInvariants()],
];
for (const [name, result] of checks) {
  const failed = result.cases.filter((item) => item.actual !== item.expected);
  assert.equal(result.ok, true, `${name} invariants failed: ${JSON.stringify(failed)}`);
  console.log(`${name} invariants: ${result.cases.length} cases passed`);
}

// This script runs directly in Node before the Next build. Keep the profit
// guard check static because simulate-profit.ts uses a Next/TS path alias.
const [profit, supplySelector, marketSelector] = await Promise.all([
  readFile(new URL("../lib/intelligence/simulate-profit.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-sales-tests.ts", import.meta.url), "utf8"),
]);
assert.match(profit, /requireDomesticShipping === true && args\.domesticShipping == null/);
assert.match(profit, /unknown\("domestic_shipping_unknown"\)/);
assert.match(supplySelector, /requireDomesticShipping: true/);
assert.match(marketSelector, /requireDomesticShipping: true/);
console.log("fully costed publication guard: 4 assertions passed");
