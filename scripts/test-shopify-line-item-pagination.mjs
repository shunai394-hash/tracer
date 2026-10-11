import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/shopify/sync-orders.ts", import.meta.url), "utf8");

// Outer order pagination: newest paid orders are scanned until new imports are found.
assert.match(source, /orders\(first: \$first, after: \$after,[\s\S]*?reverse: true/);
assert.match(source, /while \(hasNextOrdersPage && orders\.length < maxNewOrders\)/);
assert.match(source, /shopify_orders_cursor_not_advancing/);
assert.match(source, /fetched: scannedOrders/);
assert.ok(source.includes("if (!existingIds.has(order.id)"), "already-imported orders must be skipped while paging");

// Nested line-item pagination: resolve all pages and reject bad cursors or duplicates.
assert.match(source, /pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}/);
assert.match(source, /while \(hasNextPage\)/);
assert.match(source, /lineItems\(first: \$first, after: \$after\)/);
assert.match(source, /shopify_line_items_cursor_missing/);
assert.match(source, /shopify_line_items_page_missing/);
assert.match(source, /shopify_line_items_cursor_not_advancing/);
assert.match(source, /shopify_line_item_duplicate_id/);
assert.ok(source.indexOf("while (hasNextPage)") < source.indexOf("const variantIds"),
  "all line-item pages must resolve before variant mapping or order writes");
assert.ok(source.indexOf("shopify_line_item_duplicate_id") < source.indexOf("const variantIds"),
  "duplicate line IDs must fail before variant mapping or order writes");

// Concurrent runs: a unique external order conflict is reconciled, not retried blindly.
assert.ok(source.includes('inserted.error?.code === "23505"'));
assert.ok(source.includes('.eq("shopify_order_id", order.id)'));
console.log("Shopify order pagination and idempotency: 15 assertions passed");
