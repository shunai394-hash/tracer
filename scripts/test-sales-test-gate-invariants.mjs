import assert from "node:assert/strict";
import { verifySalesTestGateInvariants } from "../lib/market/sales-test-gate.ts";

const result = verifySalesTestGateInvariants();
const failed = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `Sales test gate invariants failed: ${JSON.stringify(failed)}`);
console.log(`Sales test gate invariants: ${result.cases.length} cases passed`);
