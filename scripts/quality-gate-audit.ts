import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifySalesTestGateInvariants } from "@/lib/market/sales-test-gate";
import { verifyWomenPriorityInvariants } from "@/lib/intelligence/womens-priority";

const root = process.cwd();
const checks = [
  ["Shopify legacy sync", "lib/shopify/sync.ts", "hasPassedSalesTestGate"],
  ["Shopify canonical sync", "lib/shopify/sync-published-listings.ts", "hasPassedSalesTestGate"],
  ["Shopify sync live-stock guard", "lib/shopify/sync-published-listings.ts", "Number(row.inventory) > 0"],
  ["Shopify live supplier order contract", "lib/shopify/sync-published-listings.ts", "hasLiveSupplierOrderContract(row)"],
  ["Shopify fresh supplier inventory", "lib/shopify/sync-published-listings.ts", "supplier_live_inventory_unverified"],
  ["Shopify live cost and shipping revalidation", "lib/shopify/sync-published-listings.ts", "supplier_live_shipping_changed_revalidation_required"],
  ["Shopify failed unpublish preserves confirmed state", "lib/shopify/sync-published-listings.ts", "shopify_unpublish_failed_manual_action_required"],
  ["Shopify final CJ supplier safety boundary", "lib/shopify/sync-published-listings.ts", '!/^(cj|cjdropshipping)$/i.test(String(row.supplier_name ?? "").trim())'],
  ["Shopify Japanese title boundary", "lib/shopify/sync-published-listings.ts", "isJapaneseProductTitle(row.title)"],
  ["Orosy live order fail-closed", "lib/procurement/orosy-adapter.ts", "OROSY_ORDER_BLOCKED_CART_STATE"],
  ["Orosy live order preflight", "lib/procurement/orosy-adapter.ts", "OROSY_ORDER_PREFLIGHT_PASSED"],
  ["Orosy variant live revalidation", "lib/procurement/orosy-adapter.ts", "OROSY_LIVE_STOCK_GATE_FAILED"],
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
  ["BASE publisher canonical gate", "lib/channels/base-publisher.ts", "hasPassedSalesTestGate"],
  ["BASE publisher tracking revalidation", "lib/channels/base-publisher.ts", "tracking_unavailable"],
  ["BASE publisher variant identity revalidation", "lib/channels/base-publisher.ts", "supplier_variant_identity_missing"],
  ["BASE publisher idempotent claim", "lib/channels/base-publisher.ts", "base_publication_claim_lost"],
  ["BASE publisher image contract", "lib/channels/base-publisher.ts", "imageNo: 1"],
  ["Supply sales selector", "lib/market/select-supply-sales-tests.ts", "evaluateSalesTestGate"],
  ["Market sales selector", "lib/market/select-sales-tests.ts", "SALES_TEST_GATE_PASSED"],
  ["CJ identity reverify", "lib/suppliers/reverify-cj-identity.ts", "variantBarcode"],
  ["CJ womens recovery priority", "lib/suppliers/reverify-cj-identity.ts", "womensSelected"],
  ["CJ womens recovery prioritizes unverified", "lib/suppliers/reverify-cj-identity.ts", "womenUnverifiedCandidates"],
  ["CJ womens variant recovery", "lib/suppliers/repair-cj-variants.ts", "repairCjMissingWomenVariants"],
  ["CJ womens variant recovery cron", "app/api/cron/cj-variant-repair/route.ts", "requireAutomationAuth"],
  ["Women-focused CJ selection", "lib/intelligence/cj-selection.ts", "womenProductPriority"],
  ["Women-focused supplier selection", "lib/intelligence/supplier-selection.ts", "womenProductPriority"],
  ["Women priority canonical sales selection", "lib/market/select-sales-tests.ts", "women_priority_"],
  ["Women priority supply sales selection", "lib/market/select-supply-sales-tests.ts", "womenProductPriority"],
  ["Women priority storefront ordering", "lib/shop/store.ts", "womenBonus"],
  ["Women-focused catalog discovery", "lib/suppliers/discover-cj-supply.ts", "women fashion"],
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
