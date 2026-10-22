import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [route, store, migration, dashboard] = await Promise.all([
  readFile(new URL("../app/api/admin/manual-inventory/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20261022130000_manual_tracer_inventory.sql", import.meta.url), "utf8"),
  readFile(new URL("../components/manual-inventory-panel.tsx", import.meta.url), "utf8"),
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
assert.match(route, /export async function DELETE/, "manual products must support safe archive from the dashboard");
assert.match(route, /export async function PATCH/, "archived manual products must be restorable");
assert.match(route, /manual_admin_archive/, "removing a manual product must archive rather than hard-delete it");
assert.match(dashboard, /商品名で検索/, "dashboard must support finding products by title");
assert.match(dashboard, /非公開・退避/, "dashboard must expose a clear safe removal action");
assert.match(dashboard, /退避済み/, "dashboard must separate archived products from active management");

console.log("TRACER manual inventory contract tests passed");
