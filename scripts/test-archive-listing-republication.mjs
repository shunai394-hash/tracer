import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, basePublisher, shopifySync, inventoryRefresh, basePriceReconcile, newfind, newfindReconcile, supplySelector, marketSelector] = await Promise.all([
  readFile("supabase/migrations/20261019070000_shop_listings_archive_guard.sql", "utf8"),
  readFile("lib/channels/base-publisher.ts", "utf8"),
  readFile("lib/shopify/sync-published-listings.ts", "utf8"),
  readFile("app/api/cron/inventory-refresh/route.ts", "utf8"),
  readFile("app/api/cron/base-legacy-price-reconcile/route.ts", "utf8"),
  readFile("lib/integration/newfind.ts", "utf8"),
  readFile("lib/integration/newfind-reconcile.ts", "utf8"),
  readFile("lib/market/select-supply-sales-tests.ts", "utf8"),
  readFile("lib/market/select-sales-tests.ts", "utf8"),
]);

assert.match(migration, /add column if not exists archived_at timestamptz/i);
assert.match(migration, /add column if not exists archive_reason text/i);
assert.match(migration, /where archived_at is null/i);

// The filter is applied before the explicit listingIds branch, so admin retries
// cannot bypass the archive guard.
assert.match(basePublisher, /from\("shop_listings"\)[\s\S]*?\.is\("archived_at", null\)[\s\S]*?if \(listingIds && listingIds\.length > 0\)/);
assert.match(shopifySync, /from\("shop_listings"\)[\s\S]*?\.is\("archived_at", null\)[\s\S]*?if \(listingIds\?\.length\)/);

// Both inventory-refresh work pools and the BASE legacy price reconciler must
// exclude archived listings before reading candidates for downstream updates.
assert.equal((inventoryRefresh.match(/\.is\("archived_at", null\)/g) ?? []).length, 2);
assert.match(basePriceReconcile, /from\("shop_listings"\)[\s\S]*?\.is\("archived_at", null\)[\s\S]*?\.eq\("published", true\)/);

// NEWFIND retry, direct promotion, and reconciliation paths must reject archived rows.
assert.match(newfind, /select\("id, title, published, archived_at[\s\S]*?\.is\("archived_at", null\)[\s\S]*?\.eq\("published", true\)/);
assert.match(newfind, /select\("id, slug, title[\s\S]*?published, archived_at[\s\S]*?\.is\("archived_at", null\)[\s\S]*?\.eq\("published", true\)/);
assert.equal((newfindReconcile.match(/\.is\("archived_at", null\)/g) ?? []).length, 3);
assert.match(newfindReconcile, /published, archived_at[\s\S]*?\.is\("archived_at", null\)/);

assert.ok(supplySelector.includes('.select("id, archived_at").eq("slug", slug).maybeSingle()'));
assert.ok(supplySelector.includes("if (existing.data?.archived_at) continue;"));
assert.ok(supplySelector.includes('.select("id, archived_at").eq("product_id", item.productId).is("archived_at", null)'));
assert.ok(supplySelector.includes("if (byProduct.data?.archived_at) continue;"));
assert.ok(marketSelector.includes('.from("shop_listings")') && marketSelector.includes('.eq("supplier_variant_id", supplierVariantId)') && marketSelector.includes('.eq("slug", slug)'));
assert.ok(marketSelector.includes("if (existing?.archived_at) continue;"), "market selector must not republish archived canonical-identity matches");

console.log("Archived listing republication guards passed.");
