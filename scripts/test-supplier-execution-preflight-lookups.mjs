import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/ordering/supplier-execution.ts", import.meta.url), "utf8");

test("initial shop order lookup errors or missing rows fail closed", () => {
  assert.match(source, /from\("shop_orders"\)[\s\S]*?\.maybeSingle\(\)/);
  assert.match(source, /shop_order_lookup_failed_manual_reconciliation_required/);
  assert.match(source, /shop_order_missing_manual_reconciliation_required/);
});

test("purchase order item lookup errors or missing rows fail closed", () => {
  assert.match(source, /data: item, error: itemLookupError/);
  assert.match(source, /purchase_order_item_lookup_failed_manual_reconciliation_required/);
  assert.match(source, /purchase_order_item_missing_manual_reconciliation_required/);
});

test("duplicate supplier attempt lookup errors fail closed before supplier API call", () => {
  assert.match(source, /data: duplicateAttempts, error: duplicateAttemptsError/);
  assert.match(source, /duplicate_supplier_attempt_lookup_failed_manual_reconciliation_required/);
  const duplicateLookup = source.indexOf("duplicate_supplier_attempt_lookup_failed_manual_reconciliation_required");
  const externalOrderCall = source.indexOf("adapter.createOrder(orderInput)");
  assert.ok(duplicateLookup >= 0 && externalOrderCall > duplicateLookup, "duplicate lookup failure guard must precede adapter.createOrder");
});
