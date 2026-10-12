import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/20261012120000_shopify_order_atomic_import.sql", import.meta.url), "utf8");

assert.match(route, /db\.rpc\("tracer_import_shopify_order_with_items"/,
  "webhook must use the atomic database function");
assert.match(route, /p_order: orderPayload/);
assert.match(route, /p_items: itemPayloads/);
assert.match(route, /importError\.code === "23505"/,
  "concurrent duplicate webhook deliveries must reconcile the unique order ID");
assert.doesNotMatch(route, /db\.from\("shop_orders"\)\.insert\(/,
  "webhook must not separately commit the parent order");
assert.doesNotMatch(route, /db\.from\("shop_order_items"\)\.insert\(/,
  "webhook must not separately commit each line item");

assert.match(migration, /create or replace function public\.tracer_import_shopify_order_with_items/);
assert.match(migration, /returns uuid[\s\S]*?language plpgsql[\s\S]*?security invoker/);
assert.match(migration, /insert into public\.shop_orders/);
assert.match(migration, /for v_item in select value from jsonb_array_elements\(p_items\)/);
assert.match(migration, /insert into public\.shop_order_items/);
assert.match(migration, /revoke all on function public\.tracer_import_shopify_order_with_items\(jsonb, jsonb\) from public/);
assert.match(migration, /grant execute on function public\.tracer_import_shopify_order_with_items\(jsonb, jsonb\) to service_role/);
console.log("Shopify atomic order import: 11 assertions passed");
