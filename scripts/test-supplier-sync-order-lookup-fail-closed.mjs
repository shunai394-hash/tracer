import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/procurement/sync-orders.ts", import.meta.url), "utf8");

test("supplier sync rejects failed or missing customer order status lookup", () => {
  assert.match(source, /data: currentShopOrder, error: shopOrderLookupError/);
  assert.match(source, /shop_order_status_lookup_failed:/);
  assert.match(source, /shop_order_status_lookup_missing_order/);
});

test("customer tracking/status updates are only reachable after a successful order lookup", () => {
  const lookup = source.indexOf("data: currentShopOrder, error: shopOrderLookupError");
  const failureGuard = source.indexOf('throw new Error("shop_order_status_lookup_missing_order")', lookup);
  const customerUpdate = source.indexOf('supabase\n            .from("shop_orders")\n            .update(shopUpdate)', lookup);
  assert.ok(lookup >= 0 && failureGuard > lookup);
  assert.ok(customerUpdate > failureGuard, "shop_orders update must follow fail-closed guards");
  assert.match(source.slice(lookup, customerUpdate), /if \(shopOrderLookupError\)/);
});
