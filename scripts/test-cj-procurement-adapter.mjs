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
assert.match(adapter, /if \(!isCJLiveOrderingEnabled\(\) \|\| !isCJAutoOrderingEnabled\(\) \|\| process\.env\.CJ_PAYMENT_FLOW_VERIFIED\?\.trim\(\) !== "1" \|\| !getCJConfig\(\)\.apiKey\)/, "createOrder itself must fail closed until payment flow is verified");
assert.match(adapter, /paymentConfirmed: Boolean\(status\.paymentDate/);

assert.doesNotMatch(registry, /normalized === "cj"/, "CJ must no longer be permanently excluded from the adapter registry");
assert.match(registry, /normalized === "superdelivery"/);
assert.match(init, /registerSupplierAdapter\(cjSupplierAdapter\)/);
assert.match(env, /return isCJLiveOrderingEnabled\(\)/);
assert.match(env, /return isCJAutoOrderingEnabled\(\)/);

assert.match(client, /features: "enable_inventory"/);
assert.match(client, /Number\(inventoryRow\.verifiedWarehouse\) !== 1/);
assert.match(client, /Number\(inventoryRow\.cjInventory\)/);
assert.match(order, /body\.payType = input\.payType \?\? \(input\.isSandbox \? 3 : 2\)/);
assert.match(order, /if \(input\.isSandbox\) body\.isSandbox = 1/);
assert.match(order, /required CJ createOrderV2 field is missing/);
assert.doesNotMatch(inventoryRefresh, /getAutoProcurementEligibility/,
  "missing auto-order/payment capability must not automatically unpublish products");
assert.match(inventoryRefresh, /supplier_inventory_capability_missing/);

console.log("CJ procurement adapter contract checks passed (live ordering remains fail-closed until payment proof and explicit flags).");

assert.match(order, /isSandbox\?: boolean/);
assert.match(order, /postCJSandboxAction\("simulatePay"/);
assert.match(order, /postCJSandboxAction\("updateStatus"/);
assert.match(order, /postCJSandboxAction\("updateTrackNumber"/);
assert.match(adapter, /runCJSandboxOrderLifecycle/);
assert.match(adapter, /charged: false/);
assert.match(adapter, /realFulfillment: false/);
const sandboxRoute = read("app/api/cron/cj-sandbox-order-test/route.ts");
assert.match(sandboxRoute, /CJ_SANDBOX_ORDER_TEST_ENABLED/);
assert.match(sandboxRoute, /requireAutomationAuth/);
assert.match(sandboxRoute, /SUPPLIER_LISTING_NOT_FRESH_VERIFIED_FOR_SANDBOX/);
assert.match(sandboxRoute, /TRACER CJ SANDBOX ORDER TEST COMPLETE/, "sandbox lifecycle success must be observable without logging the tracking number");
const vercelConfig = JSON.parse(read("vercel.json"));
assert.doesNotMatch(JSON.stringify(vercelConfig.crons), /cj-sandbox-order-test/, "sandbox order test must never be scheduled automatically");

const cjReverifySource = read("lib/suppliers/reverify-cj-identity.ts");
assert.match(cjReverifySource, /verification_error === "storefront_stock_cap_deploy_pending"/, "only the explicit storefront stock-cap hold may be recovered");
assert.match(cjReverifySource, /TRACER_STOREFRONT_STOCK_CAP_DEPLOYED === "1"/, "stock-cap hold recovery must require an explicit deployed-cap confirmation");
assert.match(cjReverifySource, /refreshedFields\.orderable = true/);
assert.match(cjReverifySource, /refreshedFields\.verification_error = null/);

assert.match(cjReverifySource, /eq\("verification_error", "storefront_stock_cap_deploy_pending"\)/, "explicit stock-cap holds must be queried even when the normal identity retry backoff is in the future");
assert.match(cjReverifySource, /stockCapHoldIds\.has\(String\(row\.id\)\)/, "only exact stock-cap holds may bypass the per-row retry backoff");
assert.match(cjReverifySource, /selectedStockCapHeld/, "stock-cap holds must be prioritized within the bounded re-verification batch");
