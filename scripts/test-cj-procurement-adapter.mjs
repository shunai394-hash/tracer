import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const adapter = read("lib/procurement/cj-adapter.ts");
const registry = read("lib/procurement/registry.ts");
const init = read("lib/procurement/init.ts");
const env = read("lib/config/env.ts");
const client = read("lib/sources/cj/client.ts");
const order = read("lib/sources/cj/create-order.ts");
const inventoryRefresh = read("app/api/cron/inventory-refresh/route.ts");

assert.match(adapter, /name: "cj"/);
assert.match(adapter, /inventoryByCountry/);
assert.match(adapter, /Number\.isSafeInteger\(input\.quantity\)/);
assert.match(adapter, /fromCountryCode: freight\.countryCode/);
assert.match(adapter, /logisticName: freight\.logisticName/);
assert.match(adapter, /payType: 2/);
assert.match(adapter, /process\.env\.CJ_PAYMENT_FLOW_VERIFIED\?\.trim\(\) === "1"/);
assert.match(adapter, /isCJLiveOrderingEnabled\(\)/);
assert.match(adapter, /isCJAutoOrderingEnabled\(\)/);
assert.match(adapter, /paymentConfirmed: Boolean\(status\.paymentDate/);

assert.doesNotMatch(registry, /normalized === "cj"/, "CJ must no longer be permanently excluded from the adapter registry");
assert.match(registry, /normalized === "superdelivery"/);
assert.match(init, /registerSupplierAdapter\(cjSupplierAdapter\)/);
assert.match(env, /return isCJLiveOrderingEnabled\(\)/);
assert.match(env, /return isCJAutoOrderingEnabled\(\)/);

assert.match(client, /features: "enable_inventory"/);
assert.match(client, /Number\(inventoryRow\.verifiedWarehouse\) !== 1/);
assert.match(client, /Number\(inventoryRow\.cjInventory\)/);
assert.match(order, /body\.payType = input\.payType \?\? 2/);
assert.match(order, /required CJ createOrderV2 field is missing/);
assert.doesNotMatch(inventoryRefresh, /getAutoProcurementEligibility/,
  "missing auto-order/payment capability must not automatically unpublish products");
assert.match(inventoryRefresh, /supplier_inventory_capability_missing/);

console.log("CJ procurement adapter contract checks passed (live ordering remains fail-closed until payment proof and explicit flags).");
