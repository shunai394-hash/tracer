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
assert.match(route, /action === "unpublish"/, "admin must be able to stop TRACER publication");
assert.match(route, /action === "archive"/, "admin must be able to archive manual listings without hard deletion");
assert.match(route, /\.select\("id,product_id,slug,title,description,image_url,selling_price,currency,inventory,published,published_at,manual_inventory,supplier_name/, "admin list must include supplier-linked listings");
assert.match(dashboard, /掲載停止/, "dashboard must expose a listing stop action");
assert.match(dashboard, /アーカイブ/, "dashboard must expose a safe archive action for manual listings");
assert.match(route, /published && \(!imageUrl \|\| inventory < 1\)/, "publishing must require an image and positive stock");
assert.match(route, /manual_inventory: true/, "new manual listings must be explicitly marked");
assert.match(route, /isPublishableCatalogTitle\(title\)/, "publish action must enforce the storefront title gate");
assert.match(route, /isPublishableCatalogDescription\(description\)/, "publish action must enforce the storefront description gate");
assert.match(store, /manual_inventory\.eq\.true/, "TRACER-owned listings must be independently queryable");
assert.match(store, /reserve_manual_listing_stock/, "checkout must reserve manual stock");
assert.match(store, /release_manual_listing_stock/, "failed order writes must release reserved manual stock");
assert.match(migration, /where manual_inventory = true[\s\S]*inventory >= p_quantity/, "stock reservation must be atomic and bounded by available inventory");
assert.match(dashboard, /TRACERの商品一覧に公開する/, "dashboard must expose a manual publish control");

console.log("TRACER manual inventory contract tests passed");
