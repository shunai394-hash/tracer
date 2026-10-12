import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, schema] = await Promise.all([
  readFile(new URL("../supabase/migrations/20261012100000_shopify_line_item_idempotency.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20261012090000_shop_order_item_schema_compat.sql", import.meta.url), "utf8"),
]);
assert.match(schema, /shopify_line_item_id text/);
assert.match(schema, /supplier_listing_id uuid/);
assert.match(schema, /supplier_name text/);
assert.match(schema, /supplier_product_id text/);
assert.match(schema, /supplier_variant_id text/);
assert.match(migration, /having count\(\*\) > 1/);
assert.match(migration, /duplicate_shopify_line_item_ids_require_manual_reconciliation/);
assert.match(migration, /create unique index if not exists shop_order_items_shopify_line_item_unique_idx/);
assert.match(migration, /on public\.shop_order_items\(shopify_line_item_id\)/);
assert.match(migration, /where shopify_line_item_id is not null/);
console.log("Shopify line-item schema and DB idempotency migration contract: 10 assertions passed");
