import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifySalesTestGateInvariants } from "@/lib/market/sales-test-gate";

const root = process.cwd();
const checks = [
  ["Shopify legacy sync", "lib/shopify/sync.ts", "hasPassedSalesTestGate"],
  ["Shopify canonical sync", "lib/shopify/sync-published-listings.ts", "hasPassedSalesTestGate"],
  ["Shopify storefront store", "lib/shop/store.ts", "shopify_sync_status"],
  ["Shopify storefront publication filter", "lib/shop/store.ts", "shopify_product_id"],
  ["Shopify storefront UI", "app/shop/page.tsx", "SHOPIFY LIVE"],
  ["BASE publisher", "lib/channels/base-publisher.ts", "hasPassedSalesTestGate"],
  ["Supply sales selector", "lib/market/select-supply-sales-tests.ts", "evaluateSalesTestGate"],
  ["Market sales selector", "lib/market/select-sales-tests.ts", "SALES_TEST_GATE_PASSED"],
  ["CJ identity reverify", "lib/suppliers/reverify-cj-identity.ts", "variantBarcode"],
] as const;

const failures: string[] = [];
const invariant = verifySalesTestGateInvariants();
if (!invariant.ok) failures.push(`sales-test-gate invariants failed: ${JSON.stringify(invariant.cases)}`);

for (const [name, relativePath, required] of checks) {
  const path = resolve(root, relativePath);
  const source = readFileSync(path, "utf8");
  if (!source.includes(required)) failures.push(`${name}: missing required guard ${required}`);
}

if (failures.length) {
  console.error("TRACER QUALITY GATE AUDIT: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("TRACER QUALITY GATE AUDIT: PASS");
console.log(`Checked ${checks.length} critical publication/downstream paths plus ${invariant.cases.length} gate invariants.`);
