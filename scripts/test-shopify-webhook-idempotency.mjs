import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261012160000_shopify_order_line_idempotency.sql", import.meta.url), "utf8");

test("Shopify webhook retries reconcile line items instead of returning on an existing parent", () => {
  assert.match(route, /let orderId = existing\.data \? String\(existing\.data\.id\) : null/);
  assert.match(route, /shop_order_items"\)\.upsert\(/);
  assert.match(route, /onConflict: "order_id,shopify_line_item_id"/);
  assert.match(route, /duplicate: Boolean\(existing\.data\)/);
});

test("Shopify webhook rejects missing or duplicate line IDs and invalid quantity/price", () => {
  assert.match(route, /shopify_line_item_id_invalid/);
  assert.match(route, /line_item_quantity_or_price_invalid/);
  assert.match(route, /!Number\.isInteger\(quantity\) \|\| quantity <= 0/);
});

test("Shopify order lines have a database uniqueness guard, with duplicate preflight", () => {
  assert.match(migration, /group by order_id, shopify_line_item_id\s+having count\(\*\) > 1/i);
  assert.match(migration, /create unique index if not exists shop_order_items_shopify_line_item_unique/i);
  assert.match(migration, /on public\.shop_order_items\(order_id, shopify_line_item_id\)/i);
});
