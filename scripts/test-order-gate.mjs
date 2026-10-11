import assert from "node:assert/strict";
import { verifyOrderGateInvariants } from "../lib/ordering/gates.ts";

const result = verifyOrderGateInvariants();
const failed = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `Order gate invariants failed: ${JSON.stringify(failed)}`);
console.log(`Order gate invariants: ${result.cases.length} cases passed`);
