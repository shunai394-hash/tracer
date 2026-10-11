import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyDropshipOrderGateInvariants } from "../lib/ordering/dropship-gate.ts";

const result = verifyDropshipOrderGateInvariants();
const failures = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `Dropship order gate invariant failures: ${JSON.stringify(failures)}`);

const orderControl = await readFile(new URL("../lib/ordering/autonomous-control.ts", import.meta.url), "utf8");
const dropship = await readFile(new URL("../lib/ordering/dropship.ts", import.meta.url), "utf8");
const supplierExecution = await readFile(new URL("../lib/ordering/supplier-execution.ts", import.meta.url), "utf8");
assert.match(orderControl, /\.in\("order_status", \["placed", "processing", "fulfillment_pending"\]\)/);
assert.doesNotMatch(orderControl, /\.in\("order_status", \[[^\]]*fulfilled/);
assert.match(dropship, /supplierIdentityStatus: typeof listingRow\.identity_status === "string" \? listingRow\.identity_status : null/, "PO intent must pass the actual supplier identity state into the gate");
assert.match(supplierExecution, /if \(isCjSupplierName\(supplierName\)\)/, "live CJ execution must re-check canonical identity");
assert.match(supplierExecution, /identityRows\?\.length !== 1 \|\| identityRows\[0\]\.identity_status !== "linked"/, "live CJ execution must require exactly one linked supplier product+variant");
assert.match(supplierExecution, /supplier_identity_lookup_failed/);
assert.match(supplierExecution, /supplier_identity_unlinked_or_ambiguous/);
console.log(`Dropship order gate: ${result.cases.length} invariant cases passed; fulfilled orders excluded`);
