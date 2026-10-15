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
assert.match(dropship, /supplierIdentityStatus: typeof listingRow\.identity_status === "string" \? listingRow\.identity_status : null/, "PO intent must pass the actual supplier identity state into the gate");
assert.match(dropship, /shipping_cost: internalVariant\.shipping_cost \?\? \(internalVariant\.internal_supply_products as Record<string, unknown> \| null\)\?\.shipping_cost \?\? null/, "missing internal supply shipping must stay unknown instead of becoming zero");
assert.match(dropship, /currency: internalVariant\.currency \?\? \(internalVariant\.internal_supply_products as Record<string, unknown> \| null\)\?\.currency \?\? null/, "missing internal supply currency must stay unknown instead of becoming JPY");
assert.doesNotMatch(dropship, /currency: typeof listingRow\.currency === "string" \? listingRow\.currency : row\.currency/, "purchase-order currency must not fall back to the selling currency when supplier currency is unknown");
assert.match(supplierExecution, /if \(isCjSupplierName\(supplierName\)\)/, "live CJ execution must re-check canonical identity");
assert.match(supplierExecution, /const uniqueExactVariant = identityRows\?\.length === 1/, "live CJ execution must require one exact supplier product+variant");
assert.match(supplierExecution, /identity_status === "supply_discovered"[\s\S]*?isNativeCjSupplierListing/, "standalone CJ execution must require fresh verified native-supply evidence");
assert.match(supplierExecution, /supplier_identity_lookup_failed/);
assert.match(supplierExecution, /supplier_identity_unlinked_or_ambiguous/);
assert.match(executionRoute, /externalLiveOrderCapableSupplierCount/, "scheduled order execution must expose whether any external supplier can actually accept live orders");
assert.match(executionRoute, /internalOrderableVariantCount/, "scheduled order execution must report orderable internal variant count");
assert.match(executionRoute, /internalOrderableVariantQueryOk/, "readiness query failure must be distinguishable from zero orderable variants");
console.log(`Dropship order gate: ${result.cases.length} invariant cases passed; fulfilled orders excluded`);
