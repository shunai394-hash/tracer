import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/shopify/sync-orders.ts", import.meta.url), "utf8");

// Outer order pagination: scan recent paid orders until new imports or pending retries are found.
assert.match(source, /orders\(first: \$first, after: \$after,[\s\S]*?reverse: true/);
assert.match(source, /while \(hasNextOrdersPage && orders\.length < maxNewOrders\)/);
assert.match(source, /shopify_orders_cursor_not_advancing/);
assert.match(source, /fetched: scannedOrders/);
assert.match(source, /existingById\.get\(canonicalShopifyId\(order\.id, "Order"\)\)/);
assert.match(source, /if \(\(!knownStatus \|\| knownStatus === "procurement_pending"\) && orders\.length < maxNewOrders\) orders\.push\(order\)/,
  "new orders and procurement-pending retries must be queued; completed orders must be skipped");
// The GraphQL query only scans open, paid, unfulfilled orders.
assert.match(source, /financial_status:paid status:open fulfillment_status:unfulfilled/);
assert.match(source, /cancelledAt: string \| null/);
assert.match(source, /if \(order\.cancelledAt \|\| order\.displayFinancialStatus !== "PAID" \|\| order\.displayFulfillmentStatus !== "UNFULFILLED"\)/);
assert.match(source, /order\.displayFulfillmentStatus !== "UNFULFILLED"/);
assert.ok(source.indexOf('if (order.cancelledAt || order.displayFinancialStatus !== "PAID" || order.displayFulfillmentStatus !== "UNFULFILLED")') < source.indexOf("await ingestPaidOrder({"),
  "cancelled, unpaid, fulfilled, or partially fulfilled orders must be excluded before canonical ingestion");

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

// Concurrent runs: order writes are delegated to the canonical idempotent ingestion path.
assert.ok(source.includes("await ingestPaidOrder({"), "Shopify imports must use canonical commerce order ingestion");
assert.ok(source.includes('externalOrderId: canonicalShopifyId(order.id, "Order")'), "Shopify order IDs must be canonicalized before idempotent upsert");

// A Shopify variant may not silently map to the last of several internal listings.
assert.match(source, /shopify_variant_mapping_ambiguous/);
assert.ok(source.indexOf("shopify_variant_mapping_ambiguous") < source.indexOf("await ingestPaidOrder({"),
  "ambiguous variant mappings must fail before canonical order ingestion");
console.log("Shopify order pagination and idempotency: assertions passed");
