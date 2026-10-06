import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifySalesTestGateInvariants } from "@/lib/market/sales-test-gate";
import { verifyWomenPriorityInvariants } from "@/lib/intelligence/womens-priority";

const root = process.cwd();
const checks = [
  ["Shopify legacy sync", "lib/shopify/sync.ts", "hasPassedSalesTestGate"],
  ["Shopify canonical sync", "lib/shopify/sync-published-listings.ts", "hasPassedSalesTestGate"],
  ["Shopify sync live-stock guard", "lib/shopify/sync-published-listings.ts", "Number(row.inventory) > 0"],
  ["Shopify storefront store", "lib/shop/store.ts", "shopify_sync_status"],
  ["Shopify storefront publication filter", "lib/shop/store.ts", "shopify_product_id"],
  ["Shopify storefront inventory filter", "lib/shop/store.ts", '.gt("inventory", 0)'],
  ["Shopify storefront orderability filter", "lib/shop/store.ts", '.eq("orderable", true)'],
  ["Shopify storefront tracking filter", "lib/shop/store.ts", '.eq("tracking_available", true)'],
  ["Shopify storefront UI", "app/shop/page.tsx", "SHOPIFY LIVE"],
  ["Shopify product detail", "app/shop/[slug]/page.tsx", "AddToCartButton"],
  ["Shopify channel cron", "app/api/cron/shopify-publish/route.ts", "isShopifyConfigured"],
  ["Shopify catalog audit endpoint", "app/api/admin/shopify/catalog/route.ts", "storefrontContract"],
  ["Shopify readiness audit", "scripts/shopify-channel-audit.ts", "SHOPIFY_ADMIN_ACCESS_TOKEN"],
  ["Shopify readiness womens telemetry", "app/api/admin/shopify/readiness/route.ts", "womensCanonicalReady"],
  ["BASE publisher", "lib/channels/base-publisher.ts", "hasPassedSalesTestGate"],
  ["Supply sales selector", "lib/market/select-supply-sales-tests.ts", "evaluateSalesTestGate"],
  ["Market sales selector", "lib/market/select-sales-tests.ts", "SALES_TEST_GATE_PASSED"],
  ["CJ identity reverify", "lib/suppliers/reverify-cj-identity.ts", "variantBarcode"],
  ["CJ womens recovery priority", "lib/suppliers/reverify-cj-identity.ts", "womensSelected"],
  ["CJ womens recovery prioritizes unverified", "lib/suppliers/reverify-cj-identity.ts", "womenUnverifiedCandidates"],
  ["CJ womens variant recovery", "lib/suppliers/repair-cj-variants.ts", "repairCjMissingWomenVariants"],
  ["CJ womens variant recovery cron", "app/api/cron/cj-variant-repair/route.ts", "requireAutomationAuth"],
  ["Women-focused CJ selection", "lib/intelligence/cj-selection.ts", "womenProductPriority"],
  ["Women-focused supplier selection", "lib/intelligence/supplier-selection.ts", "womenProductPriority"],
  ["Women-focused catalog discovery", "lib/suppliers/discover-cj-supply.ts", ""women fashion""],
  ["CJ identifier-first recovery", "lib/suppliers/reverify-cj-identity.ts", "identifierFirst"],
  ["CJ identity resolver listing identifiers", "lib/intelligence/persist-cj-supply-intelligence.ts", "supplierIdentifiers"],
  ["CJ barcode candidate safety", "lib/intelligence/persist-cj-supply-intelligence.ts", "barcodeCandidates"],
  ["CJ identity lookup truncation safety", "lib/intelligence/persist-cj-supply-intelligence.ts", ".limit(50)"],
  ["CJ variant recovery twice daily", "vercel.json", "7 18 * * *"],
  ["CJ identity recovery twice daily", "vercel.json", "9 18 * * *"],
] as const;

const failures: string[] = [];
const invariant = verifySalesTestGateInvariants();
const womenInvariant = verifyWomenPriorityInvariants();
if (!womenInvariant.ok) failures.push(`women-priority invariants failed: ${JSON.stringify(womenInvariant.cases)}`);
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
