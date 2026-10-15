import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/ordering/verified-supplier-execution.ts", import.meta.url), "utf8");
assert.match(source, /import \{ persistOrderStateUpdate \} from "@\/lib\/ordering\/status-write"/);
assert.match(source, /context: "supplier_payment_verification_failed"[\s\S]*?failureWrite\.ok/,
  "a payment-status lookup failure must surface a failed DB status write");
assert.match(source, /context: "supplier_payment_pending"[\s\S]*?if \(!pendingWrite\.ok\)/,
  "pending payment state must fail closed when its purchase-order write fails");
assert.match(source, /context: "supplier_payment_pending_attempt"[\s\S]*?if \(!attemptWrite\.ok\)/,
  "pending payment attempt persistence must be checked");
assert.match(source, /supplier_payment_confirmation_persist_failed_manual_reconciliation_required/,
  "confirmed payment must not be treated as successful when the purchase-order update fails");
assert.match(source, /context: "supplier_payment_confirmed_attempt"[\s\S]*?if \(!confirmedAttemptWrite\.ok\)/,
  "confirmed payment attempt persistence must be checked");
assert.match(source, /supplier_payment_confirmation_attempt_persist_failed_manual_reconciliation_required/,
  "attempt write failure after payment confirmation must require reconciliation");
console.log("Supplier payment persistence: all failure paths fail closed");
