import assert from "node:assert/strict";
import { recoverSupplierPaymentState } from "../lib/ordering/supplier-payment-recovery.ts";

const makeDeps = (overrides = {}) => {
  const calls = [];
  const deps = {
    orderStatusSupported: true,
    lookupOrderStatus: async (id) => { calls.push(["lookup", id]); return { status: "paid", paymentConfirmed: true }; },
    updateAttempt: async (po, supplier) => { calls.push(["attempt", po, supplier]); return { data: { id: "attempt-1" }, error: null }; },
    updatePurchaseOrder: async (po, allowed, patch) => { calls.push(["po", po, allowed, patch]); return { data: { id: po }, error: null }; },
    now: () => "2026-10-12T00:00:00.000Z",
    setStage: (stage) => calls.push(["stage", stage]),
    ...overrides,
  };
  return { deps, calls };
};
const run = (dependencies) => recoverSupplierPaymentState({
  purchaseOrderId: "po-1",
  supplierOrderId: "supplier-1",
  currentMetadata: { keep: "existing", supplier_payment: { prior: true } },
  dependencies,
});

// 1. Explicit confirmation requires attempt ledger and PO writes; success promotes to placed.
{
  const { deps, calls } = makeDeps();
  const result = await run(deps);
  assert.equal(result.status, "placed");
  assert.equal(result.supplierStatus, "paid");
  assert.deepEqual(calls.filter((c) => c[0] === "lookup").length, 1);
  assert.deepEqual(calls.filter((c) => c[0] === "attempt").length, 1);
  assert.deepEqual(calls.filter((c) => c[0] === "po").length, 1);
  const patch = calls.find((c) => c[0] === "po")[3];
  assert.equal(patch.metadata.keep, "existing");
  assert.equal(patch.metadata.supplier_payment.confirmed, true);
}
// 2. Unconfirmed status stays pending and never updates attempt ledger.
{
  const { deps, calls } = makeDeps({ lookupOrderStatus: async () => ({ status: "processing", paymentConfirmed: false }) });
  const result = await run(deps);
  assert.equal(result.status, "supplier_payment_pending");
  assert.equal(calls.filter((c) => c[0] === "attempt").length, 0);
  assert.equal(calls.find((c) => c[0] === "po")[3].status, "supplier_payment_pending");
}
// 3. Lookup error fails closed before any writes.
{
  const { deps, calls } = makeDeps({ lookupOrderStatus: async () => { throw new Error("lookup timeout"); } });
  await assert.rejects(run(deps), /lookup timeout/);
  assert.equal(calls.some((c) => c[0] === "attempt" || c[0] === "po"), false);
}
// 4. Unsupported status lookup performs no network call and no writes.
{
  const { deps, calls } = makeDeps({ orderStatusSupported: false });
  await assert.rejects(run(deps), /lookup_unsupported_manual_reconciliation_required/);
  assert.equal(calls.some((c) => ["lookup", "attempt", "po"].includes(c[0])), false);
}
// 5. Attempt ledger error prevents PO promotion.
{
  const { deps, calls } = makeDeps({ updateAttempt: async () => ({ data: null, error: { message: "ledger unavailable" } }) });
  await assert.rejects(run(deps), /ledger unavailable/);
  assert.equal(calls.some((c) => c[0] === "po"), false);
}
// 6. Missing attempt row prevents PO promotion.
{
  const { deps, calls } = makeDeps({ updateAttempt: async () => ({ data: null, error: null }) });
  await assert.rejects(run(deps), /attempt_ledger_missing_manual_reconciliation_required/);
  assert.equal(calls.some((c) => c[0] === "po"), false);
}
// 7. PO persistence error is not reported as success.
{
  const { deps } = makeDeps({ updatePurchaseOrder: async () => ({ data: null, error: { message: "PO write failed" } }) });
  await assert.rejects(run(deps), /PO write failed/);
}
// 8. Concurrent status change (no row matched) is not reported as success.
{
  const { deps } = makeDeps({ updatePurchaseOrder: async () => ({ data: null, error: null }) });
  await assert.rejects(run(deps), /purchase_order_update_conflict_manual_reconciliation_required/);
}
// 9. Unknown payment never calls supplier-order creation (dependencies expose lookup only).
{
  const { deps, calls } = makeDeps({ lookupOrderStatus: async () => ({ status: "unknown", paymentConfirmed: null }) });
  const result = await run(deps);
  assert.equal(result.status, "supplier_payment_pending");
  assert.equal(calls.filter((c) => c[0] === "lookup").length, 1);
  assert.equal(calls.some((c) => String(c[0]).toLowerCase().includes("create")), false);
  assert.equal(calls.filter((c) => c[0] === "attempt").length, 0);
}
console.log("Supplier payment recovery injected-failure tests: 9 scenarios passed");
