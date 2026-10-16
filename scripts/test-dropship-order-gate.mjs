import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyDropshipOrderGateInvariants } from "../lib/ordering/dropship-gate.ts";

const result = verifyDropshipOrderGateInvariants();
const failures = result.cases.filter((item) => item.actual !== item.expected);
assert.equal(result.ok, true, `Dropship order gate invariant failures: ${JSON.stringify(failures)}`);

const orderControl = await readFile(new URL("../lib/ordering/autonomous-control.ts", import.meta.url), "utf8");
const dropship = await readFile(new URL("../lib/ordering/dropship.ts", import.meta.url), "utf8");
const supplierExecution = await readFile(new URL("../lib/ordering/supplier-execution.ts", import.meta.url), "utf8");
const executionRoute = await readFile(new URL("../app/api/cron/dropship-execution/route.ts", import.meta.url), "utf8");
assert.match(orderControl, /\.in\("order_status", \["placed", "processing", "fulfillment_pending"\]\)/);
assert.doesNotMatch(orderControl, /\.in\("order_status", \[[^\]]*fulfilled/);
assert.match(dropship, /isNativeCjSupplierListing\(listingRow\) \? "native_cj_verified" : typeof listingRow\.identity_status === "string" \? listingRow\.identity_status : null/, "PO intent must translate verified exact CJ product+variant evidence into the gate's native identity state");
assert.match(supplierExecution, /if \(isCjSupplierName\(supplierName\)\)/, "live CJ execution must re-check canonical identity");
assert.match(supplierExecution, /const uniqueExactVariant = identityRows\?\.length === 1/, "live CJ execution must require one exact supplier product+variant");
assert.match(supplierExecution, /identity_status === "supply_discovered"[\s\S]*?isNativeCjSupplierListing/, "standalone CJ execution must require fresh verified native-supply evidence");
assert.match(supplierExecution, /supplier_identity_lookup_failed/);
assert.match(supplierExecution, /supplier_identity_unlinked_or_ambiguous/);
assert.match(supplierExecution, /isCJQuotaCircuitActive\(quotaMetadata\)/, "live CJ purchase must respect the persisted daily-points cooldown");
assert.ok(
  supplierExecution.indexOf("if (isCJQuotaCircuitActive(quotaMetadata))") < supplierExecution.indexOf("adapter.getVariant("),
  "CJ quota cooldown must block provider refresh before any order API call",
);
assert.match(executionRoute, /externalLiveOrderCapableSupplierCount/, "scheduled order execution must expose whether any external supplier can actually accept live orders");
assert.match(executionRoute, /internalOrderableVariantCount/, "scheduled order execution must report orderable internal variant count");
assert.match(executionRoute, /internalOrderableVariantQueryOk/, "readiness query failure must be distinguishable from zero orderable variants");
console.log(`Dropship order gate: ${result.cases.length} invariant cases passed; fulfilled orders excluded`);
