import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [verified, autonomous, attemptsMigration] = await Promise.all([
  read("../lib/ordering/verified-supplier-execution.ts"),
  read("../lib/ordering/autonomous-control.ts"),
  read("../supabase/migrations/20260925200000_tracer_supplier_order_attempts.sql"),
]);

// Source-contract checks only. End-to-end DB failure injection is still required.
const verificationCatch = verified.slice(verified.indexOf("} catch (error) {"), verified.indexOf("if (!paymentConfirmed)"));
assert.match(verificationCatch, /error: verificationPersistError/);
assert.match(verificationCatch, /verificationPersistError[\\s\\S]*?manual_reconciliation_required/);

const paymentPending = verified.slice(verified.indexOf("if (!paymentConfirmed)"), verified.indexOf("const { error: paymentPersistError }"));
assert.match(paymentPending, /error: pendingPersistError/);
assert.match(paymentPending, /error: attemptPendingPersistError/);
assert.match(paymentPending, /if \\(pendingPersistError \\|\\| attemptPendingPersistError\\)/);
assert.match(paymentPending, /manual_reconciliation_required/);

const paymentConfirmed = verified.slice(verified.indexOf("const { error: paymentPersistError }"), verified.indexOf("return {\\n    ...result,\\n    succeeded: true"));
assert.match(paymentConfirmed, /if \\(paymentPersistError\\)/);
assert.match(paymentConfirmed, /error: attemptPaymentPersistError/);
assert.match(paymentConfirmed, /if \\(attemptPaymentPersistError\\)/);
assert.match(paymentConfirmed, /manual_reconciliation_required/);

const recordEvent = autonomous.slice(autonomous.indexOf("async function recordEvent"), autonomous.indexOf("/**\\n * Autonomous order control plane"));
assert.match(recordEvent, /if \\(error\\)[\\s\\S]*?throw new Error/);
assert.doesNotMatch(recordEvent, /AUDIT SKIPPED/);

assert.match(attemptsMigration, /idempotency_key text not null unique/);
assert.match(attemptsMigration, /purchase_order_id uuid not null references public\\.purchase_orders\\(id\\) on delete cascade/);
assert.match(verified, /manual_reconciliation_required/);
console.log("Supplier payment persistence / audit fail-closed contracts: 15 assertions passed");
