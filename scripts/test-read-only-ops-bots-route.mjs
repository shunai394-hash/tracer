import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/admin/ops-bots/report/route.ts", import.meta.url), "utf8");
assert.match(route, /requireAutomationAuth\(request\)/);
assert.match(route, /export async function GET/);
assert.match(route, /runReadOnlyOperationsBots\(\{ products, generatedAt:/);
assert.match(route, /from\(table\)\.select\(columns\)/);
for (const table of ["commerce_products", "commerce_variants", "supplier_offers", "commerce_prices", "channel_listings"]) {
  assert.ok(route.includes('"' + table + '"'), "missing canonical read table: " + table);
}
assert.match(route, /Cache-Control/);
assert.match(route, /channelStockVerification/);
assert.match(route, /newfindPriceStockVerification/);
assert.doesNotMatch(route, /\.insert\s*\(|\.upsert\s*\(|\.update\s*\(|\.delete\s*\(/);
assert.doesNotMatch(route, /fetch\s*\(|shopifyGraphQL\s*\(|createCJOrder|publishProduct/);
console.log("Read-only ops-bot route contract: 12 assertions passed");
