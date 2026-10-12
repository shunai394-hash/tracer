import assert from "node:assert/strict";
import { persistOrderStateUpdate } from "../lib/ordering/status-write.ts";

const captured = [];
const originalError = console.error;
console.error = (...args) => captured.push(args);
try {
  const dbFailure = await persistOrderStateUpdate(
    { table: "purchase_orders", id: "po-test-42", purchaseOrderId: "po-test-42", context: "failure-injection" },
    async () => ({ error: { message: "injected serialization failure", code: "40001" } }),
  );
  assert.deepEqual(dbFailure, { ok: false, error: "injected serialization failure" });
  assert.equal(captured[0][0], "[TRACER ORDER STATE WRITE FAILED]");
  assert.equal(captured[0][1].id, "po-test-42");
  assert.equal(captured[0][1].purchaseOrderId, "po-test-42");
  assert.equal(captured[0][1].code, "40001");

  const thrownFailure = await persistOrderStateUpdate(
    { table: "supplier_order_attempts", id: "attempt-test-9", purchaseOrderId: "po-test-42", context: "thrown-failure-injection" },
    async () => { throw new Error("injected connection loss"); },
  );
  assert.deepEqual(thrownFailure, { ok: false, error: "injected connection loss" });
  assert.equal(captured[1][0], "[TRACER ORDER STATE WRITE THREW]");
  assert.equal(captured[1][1].id, "attempt-test-9");

  const success = await persistOrderStateUpdate(
    { table: "purchase_orders", id: "po-test-42", context: "success-injection" },
    async () => ({ error: null }),
  );
  assert.deepEqual(success, { ok: true });
  assert.equal(captured.length, 2, "successful writes must not emit failure logs");
  console.log("Order state write failure injection: 10 assertions passed");
} finally {
  console.error = originalError;
}
