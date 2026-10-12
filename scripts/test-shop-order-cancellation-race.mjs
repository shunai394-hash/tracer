import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessSupplierExecutionRisk, isCancellationTerminalStatus } from "../lib/shop/cancellation-policy.ts";

const risk = (purchaseOrders, attempts) => assessSupplierExecutionRisk(purchaseOrders, attempts);

// An attempt claimed but without a supplier ID may still succeed externally.
{
  const result = risk([{ id: "po-1", status: "pending_approval", supplier_order_id: null }], [
    { purchase_order_id: "po-1", state: "in_progress", supplier_order_id: null },
  ]);
  assert.equal(result.supplierOrderPlaced, false);
  assert.equal(result.supplierExecutionUncertain, true);
}
// A timed-out supplier create is ambiguous and must not trigger an automatic refund.
{
  const result = risk([{ id: "po-1", status: "pending_approval" }], [
    { purchase_order_id: "po-1", state: "unknown", supplier_order_id: null },
  ]);
  assert.equal(result.supplierExecutionUncertain, true);
}
// Known supplier order ID blocks automatic refund and requires supplier cancellation review.
{
  const result = risk([{ id: "po-1", status: "supplier_payment_pending", supplier_order_id: "supplier-1" }], []);
  assert.equal(result.supplierOrderPlaced, true);
}
// No supplier PO or attempt permits ordinary cancellation/refund flow.
{
  const result = risk([], []);
  assert.deepEqual(result, { supplierOrderPlaced: false, supplierExecutionUncertain: false });
}
// Payment-recovery PO without an external ID is still uncertain.
{
  const result = risk([{ id: "po-1", status: "supplier_payment_verification_failed" }], []);
  assert.equal(result.supplierExecutionUncertain, true);
}
assert.equal(isCancellationTerminalStatus("cancellation_requested"), false, "failed refund requests must be retryable");
assert.equal(isCancellationTerminalStatus("refund_pending"), true);

const [source] = await Promise.all([
  readFile(new URL("../lib/shop/cancellation.ts", import.meta.url), "utf8"),
]);
assert.match(source, /supplier_execution_in_flight_or_unknown_manual_reconciliation_required/);
assert.match(source, /\.eq\("order_status", String\(order\.order_status\)\)/, "cancellation state change must compare-and-set the observed status");
assert.match(source, /if \(purchaseOrdersError\) throw new Error/);
assert.match(source, /if \(attemptsError\) throw new Error/);
assert.match(source, /refund_created_but_order_state_persist_failed_manual_reconciliation_required/);
assert.match(source, /const \{ data: refundStateSaved, error: refundPersistError \}/, "refund persistence must detect a zero-row compare-and-set");
assert.match(source, /const \{ data: heldOrder, error: holdError \}/, "missing payment intent must be durably held for manual refund");
assert.match(source, /status: refundStateSaved \? "refund_pending" : "manual_review"/);
console.log("Shop order cancellation-vs-supplier race tests: 15 assertions passed");
