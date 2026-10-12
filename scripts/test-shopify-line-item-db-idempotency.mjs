import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../supabase/migrations/20261012100000_shopify_line_item_idempotency.sql", import.meta.url), "utf8");
assert.match(migration, /where shopify_line_item_id is not null[\s\S]*group by shopify_line_item_id[\s\S]*having count\(\*\) > 1/);
assert.match(migration, /duplicate_shopify_line_item_ids_require_manual_reconciliation/);
assert.match(migration, /create unique index if not exists shop_order_items_shopify_line_item_unique_idx/);
assert.match(migration, /on public\.shop_order_items\(shopify_line_item_id\)/);
assert.match(migration, /where shopify_line_item_id is not null/);
console.log("Shopify line-item database idempotency migration contract: 5 assertions passed");
