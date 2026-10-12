import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/ordering/reconcile.ts", import.meta.url), "utf8");

test("internal fulfillment update errors are checked and fail the reconciliation", () => {
  assert.match(source, /error: internalUpdateError/);
  assert.match(source, /if \(internalUpdateError\) throw new Error\(internalUpdateError\.message\)/);
  assert.match(source, /if \(!internalOrder\) throw new Error\("internal_fulfillment_order_not_found"\)/);
  assert.match(source, /stage = "internal_fulfillment_status_update"/);
});

test("reconciliation returns failed purchase-order IDs and per-stage reasons", () => {
  assert.match(source, /failedPurchaseOrderIds: string\[\]/);
  assert.match(source, /failureDetails: Array<\{ purchaseOrderId: string; stage: string; reason: string \}>/);
  assert.match(source, /failedPurchaseOrderIds\.push\(purchaseOrderId\)/);
  assert.match(source, /failureDetails\.push\(\{ purchaseOrderId, stage, reason \}\)/);
  assert.match(source, /purchaseOrderIds,\s*failedPurchaseOrderIds,\s*failureDetails,/);
});

test("missing supplier adapters are recorded as explicit failures", () => {
  assert.match(source, /stage: "supplier_adapter_lookup"/);
  assert.match(source, /reason: "supplier_adapter_unavailable"/);
});

test("failed and cancelled internal orders release stock before the PO leaves the retry set", async () => {
  const reconcile = await readFile(new URL("../lib/ordering/reconcile.ts", import.meta.url), "utf8");
  assert.match(reconcile, /if \(nextStatus === "failed" \|\| nextStatus === "cancelled"\)/);
  assert.match(reconcile, /release_internal_supply_reservation/);
  assert.ok(
    reconcile.indexOf("release_internal_supply_reservation") < reconcile.indexOf('stage = "purchase_order_status_update"'),
    "terminal inventory release must succeed before the purchase order status is advanced",
  );
});

test("internal fulfillment order failures use the order-keyed reservation ledger", async () => {
  const adapter = await readFile(new URL("../lib/procurement/tracer-internal-adapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /reserve_internal_supply_for_order/);
  assert.match(adapter, /release_internal_supply_reservation/);
  assert.match(adapter, /internal_fulfillment_order_insert_failed/);
  assert.match(adapter, /ORDER_NUMBER_CONFLICT/);
  assert.doesNotMatch(adapter, /release_internal_supply_variant/);
});
