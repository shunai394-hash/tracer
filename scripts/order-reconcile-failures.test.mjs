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

const baseOrders = await readFile(new URL("../lib/channels/base-orders.ts", import.meta.url), "utf8");

test("BASE sync never downgrades an already confirmed payment without refund evidence", () => {
  const existingOrderBranch = baseOrders.slice(baseOrders.indexOf("if (existing?.id)"), baseOrders.indexOf("if (summary.dispatch_status"));
  assert.match(existingOrderBranch, /else if \(String\(existing\.payment_status\) !== "paid"\)/,
    "pending BASE snapshots must not downgrade previously paid orders");
  assert.match(existingOrderBranch, /if \(String\(existing\.payment_status\) !== "paid"\) \{\s*update\.payment_status = "failed";/,
    "BASE cancellation must not overwrite confirmed payment as failed without refund evidence");
});
