import assert from "node:assert/strict";
import { verifyDropshipOrderGateInvariants } from "../lib/ordering/dropship-gate.ts";

const result = verifyDropshipOrderGateInvariants();
const failures = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `Dropship order gate invariant failures: ${JSON.stringify(failures)}`);
console.log(`Dropship order gate: ${result.cases.length} invariant cases passed`);
