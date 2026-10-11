import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("lib/shopify/sync-orders.ts", "utf8");
const migration = await readFile(
  "supabase/migrations/20261011110000_shopify_order_line_idempotency.sql",
  "utf8",
);
const cronRoute = await readFile("app/api/cron/shopify-orders/route.ts", "utf8");

assert.match(source, /orders\(first: \$first, after: \$after,[\s\S]*?reverse: true/);
assert.match(source, /while \(hasNextOrdersPage && orders\.length < maxNewOrders\)/);
assert.match(source, /shopify_orders_cursor_not_advancing/);
assert.match(source, /fetched: scannedOrders/);
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
assert.ok(source.indexOf("while (hasNextPage)") < source.indexOf("const variantIds"), "nested line items must be paginated before variant lookups and order writes");

assert.match(source, /inserted\.error\?\.code === "23505"/);
assert.match(source, /shop_order_items_insert_failed/);
assert.match(migration, /add column if not exists shopify_line_item_id text/i);
assert.match(migration, /create unique index if not exists shop_order_items_shopify_line_item_id_uidx/i);
assert.match(migration, /on public\.shop_order_items\(shopify_line_item_id\)/i);
assert.match(migration, /where shopify_line_item_id is not null/i);

// Retry the idempotent control plane even when this poll imports no new orders;
// otherwise an earlier post-ingestion failure can strand an existing paid order.
assert.match(cronRoute, /const automation = await runAutonomousOrderControl\(/);
assert.doesNotMatch(cronRoute, /imported\.imported\s*>\s*0\s*\?/);
assert.match(cronRoute, /toISOString\(\)\.slice\(0, 16\)/);

console.log("Shopify order-line idempotency and retry-trigger static checks passed.");
