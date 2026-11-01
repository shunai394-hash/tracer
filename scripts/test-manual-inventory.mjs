import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [route, store, migration, dashboard, shopifySync, basePublisher, unpublishUnlinked, supplierSelection, profitWithdraw] = await Promise.all([
  readFile(new URL("../app/api/admin/manual-inventory/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20261022130000_manual_tracer_inventory.sql", import.meta.url), "utf8"),
  readFile(new URL("../components/manual-inventory-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/unpublish-unlinked/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/commerce-minimum-profit-withdraw/route.ts", import.meta.url), "utf8"),
]);

assert.match(route, /TRACER_ADMIN_TOKEN/, "manual inventory writes must require the admin token");
assert.match(route, /timingSafeEqual/, "admin token comparison must be timing safe");
assert.match(route, /published && \(!imageUrl \|\| inventory < 1\)/, "publishing must require an image and positive stock");
assert.match(route, /manual_inventory: true/, "new manual listings must be explicitly marked");
assert.match(route, /isPublishableCatalogTitle\(title\)/, "publish action must enforce the storefront title gate");
assert.match(route, /isPublishableCatalogDescription\(description\)/, "publish action must enforce the storefront description gate");
assert.match(store, /manual_inventory\.eq\.true/, "TRACER-owned listings must be independently queryable");
assert.match(store, /reserve_manual_listing_stock/, "checkout must reserve manual stock");
assert.match(store, /release_manual_listing_stock/, "failed order writes must release reserved manual stock");
assert.match(migration, /where manual_inventory = true[\s\S]*inventory >= p_quantity/, "stock reservation must be atomic and bounded by available inventory");
assert.match(dashboard, /TRACERの商品一覧に公開する/, "dashboard must expose a manual publish control");
assert.match(route, /pipeline_reason: "merchant_held_stock"/, "manual inventory must be explicitly tagged as merchant-held stock");
assert.match(shopifySync, /isManualInventoryListing\(row\) \|\| Boolean\(row\.supplier_listing_id/, "Shopify sync must not require supplier linkage for manual stock");
assert.match(shopifySync, /manualInventoryQuantity\(row\)/, "Shopify must use exact manual inventory rather than supplier stock caps");
assert.match(basePublisher, /!manualInventory && \(!listing\.supplier_product_id \|\| !listing\.supplier_variant_id\)/, "BASE must not hide merchant-held stock for missing supplier IDs");
assert.match(basePublisher, /manualInventory \? availableInventory/, "BASE must publish the exact merchant-held quantity");
assert.match(unpublishUnlinked, /if \(isManualInventoryListing\(row\)\) return false/, "unlinked reconciliation must skip manual inventory");
assert.match(supplierSelection, /existing\.data\?\.manual_inventory === true\) continue/, "supplier selection must not overwrite manual listings");
assert.match(profitWithdraw, /manualInventoryIds/, "minimum-profit withdrawal must exclude manual inventory");

console.log("TRACER manual inventory contract tests passed");
