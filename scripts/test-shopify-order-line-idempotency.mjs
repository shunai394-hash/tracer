import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("lib/shopify/sync-orders.ts", "utf8");
const migration = await readFile(
  "supabase/migrations/20261011110000_shopify_order_line_idempotency.sql",
  "utf8",
);

assert.match(source, /shopify_line_item_id:\s*item\.id/);
assert.match(source, /shopify_order_id:\s*order\.id/);
assert.match(source, /pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}/);
assert.match(source, /while \(hasNextPage\)/);
assert.match(source, /lineItems\(first: \$first, after: \$after\)/);
assert.match(source, /shopify_line_items_cursor_missing/);
assert.match(source, /shopify_line_items_page_missing/);
assert.match(source, /shopify_line_items_cursor_not_advancing/);
assert.match(source, /shopify_line_item_duplicate_id/);

// Pagination must finish before any local DB reads/writes begin.
assert.ok(source.indexOf("while (hasNextPage)") < source.indexOf("const supabase = createSupabaseAdminClient()"));

assert.match(source, /inserted\.error\?\.code === "23505"/);
assert.match(source, /shop_order_items_insert_failed/);
assert.match(migration, /add column if not exists shopify_line_item_id text/i);
assert.match(migration, /create unique index if not exists shop_order_items_shopify_line_item_id_uidx/i);
assert.match(migration, /on public\.shop_order_items\(shopify_line_item_id\)/i);
assert.match(migration, /where shopify_line_item_id is not null/i);

console.log("Shopify order-line idempotency static checks passed.");
