import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/ordering/verified-supplier-execution.ts", import.meta.url), "utf8");

test("supplier payment verification failure state writes are checked", () => {
  assert.match(source, /error: verificationFailurePersistError/);
  assert.match(source, /supplier_payment_verification_failed_and_state_persist_failed_manual_reconciliation_required/);
});

test("supplier payment pending purchase order and attempt writes are checked", () => {
  assert.match(source, /error: pendingPersistError/);
  assert.match(source, /supplier_payment_pending_state_persist_failed_manual_reconciliation_required/);
  assert.match(source, /error: pendingAttemptPersistError/);
  assert.match(source, /supplier_payment_pending_attempt_persist_failed_manual_reconciliation_required/);
});

test("supplier payment confirmation and attempt writes are independently checked", () => {
  assert.match(source, /error: paymentPersistError/);
  assert.match(source, /error: paidAttemptPersistError/);
  assert.match(source, /supplier_payment_confirmed_but_attempt_persist_failed_manual_reconciliation_required/);
});
