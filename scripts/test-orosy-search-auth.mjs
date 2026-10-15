import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const route = await read("../app/api/intelligence/orosy-search/route.ts");
const bulkImport = await read("../app/api/cron/orosy-bulk-import/route.ts");
const procurementInit = await read("../lib/procurement/init.ts");
const supplierSearch = await read("../lib/procurement/supplier-search.ts");
const productApi = await read("../lib/intelligence/product-api.ts");
const investigation = await read("../lib/suppliers/investigate-dropship.ts");
const envExample = await read("../.env.example");
const envConfig = await read("../lib/config/env.ts");

for (const [name, source] of [["Orosy search", route], ["Orosy bulk import", bulkImport]]) {
  assert.ok(source.includes("supplier_disabled_by_product_decision"), `${name} must remain explicitly disabled`);
  assert.ok(source.includes("status: 410"), `${name} must return HTTP 410`);
}
assert.ok(!procurementInit.includes("orosySupplierAdapter"), "Orosy must not be registered for procurement");
assert.doesNotMatch(supplierSearch, /"orosy"/i, "Orosy must not be queried by active supplier discovery");
assert.doesNotMatch(productApi, /searchOrosyProducts|getOrosyProductDetail|getOrosyShippingQuote/, "product intelligence must not call Orosy");
assert.doesNotMatch(investigation, /searchOrosyProducts|getOrosyProductDetail|getOrosyShippingQuote|supplier: "orosy"/, "supplier investigation must not call Orosy or create Orosy rows");
assert.doesNotMatch(envExample, /OROSY_/, "Orosy secrets must not be part of the example runtime configuration");
assert.ok(envConfig.includes('if (name === "orosy") return false;'), "Orosy must be treated as unconfigured");
assert.ok(envConfig.includes('if (key === "OROSY") return false;'), "Orosy live and automatic ordering must stay disabled");
assert.ok(envConfig.includes("export function isOrosyLiveOrderingEnabled(): boolean {\\n  return false;"), "legacy Orosy live-ordering helper must be hard-disabled");
console.log("Orosy removal policy: 8 assertions passed");
