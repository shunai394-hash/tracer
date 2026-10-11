import assert from "node:assert/strict";
import { verifyOrderGateInvariants } from "../lib/ordering/gates.ts";

const result = verifyOrderGateInvariants();
assert.equal(result.ok, true, JSON.stringify(result.cases.filter((item) => !item.actual), null, 2));
console.log(`Order gate invariants: ${result.cases.length} passed`);
