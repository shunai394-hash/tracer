import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyDropshipOrderGateInvariants } from "../lib/ordering/dropship-gate.ts";

const result = verifyDropshipOrderGateInvariants();
const failures = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `Dropship order gate invariant failures: ${JSON.stringify(failures)}`);

const orderControl = await readFile(new URL("../lib/ordering/autonomous-control.ts", import.meta.url), "utf8");
assert.match(orderControl, /\.in\("order_status", \["placed", "processing"\]\)/);
assert.doesNotMatch(orderControl, /\.in\("order_status", \["placed", "processing", "fulfilled"\]\)/);
console.log(`Dropship order gate: ${result.cases.length} invariant cases passed; fulfilled orders excluded`);
