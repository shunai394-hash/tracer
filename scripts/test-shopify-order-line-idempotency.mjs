import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("lib/shopify/sync-orders.ts", "utf8");
const migration = await readFile(
  "supabase/migrations/20261011110000_shopify_order_line_idempotency.sql",
  "utf8",
);

assert.match(source, /shopify_line_item_id:\s*item\.id/);
assert.match(source, /shopify_order_id:\\s*order\\.id/);
assert.match(source, /inserted\.error\?\.code === "23505"/);
assert.match(source, /shop_order_items_insert_failed/);
assert.match(migration, /create unique index if not exists shop_order_items_shopify_order_line_uidx/i);
assert.match(migration, /on public\.shop_order_items\(order_id, shopify_line_item_id\)/i);
assert.match(migration, /where shopify_line_item_id is not null/i);

console.log("Shopify order-line idempotency static checks passed.");
