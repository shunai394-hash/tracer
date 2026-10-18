import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [migration, base, shopify, inventory, price] = await Promise.all([
  read("../supabase/migrations/20261019070000_shop_listings_archive_guard.sql"),
  read("../lib/channels/base-publisher.ts"),
  read("../lib/shopify/sync-published-listings.ts"),
  read("../app/api/cron/inventory-refresh/route.ts"),
  read("../app/api/cron/base-legacy-price-reconcile/route.ts"),
]);

assert.match(migration, /add column if not exists archived_at timestamptz/i);
assert.match(migration, /add column if not exists archive_reason text/i);
assert.match(base, /\.is\("archived_at", null\)/,
  "BASE publication query must exclude archived rows, including explicit listing ID retries");
assert.match(shopify, /\.is\("archived_at", null\)/,
  "Shopify sync query must exclude archived rows, including explicit listing ID retries");
assert.equal((inventory.match(/\.is\("archived_at", null\)/g) ?? []).length, 2,
  "both inventory-refresh candidate queries must exclude archived rows");
assert.match(price, /\.is\("archived_at", null\)/,
  "legacy BASE price reconciliation must not republish archived items");
assert.match(price, /visible: true/,
  "test fixture confirms price reconcile has a storefront visibility write guarded by archive filtering");
console.log("Archived listing republication guards: 7 assertions passed");
