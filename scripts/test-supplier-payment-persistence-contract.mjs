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
assert.ok(verificationCatch.includes("error: verificationPersistError"));
assert.ok(verificationCatch.includes("verificationPersistError"));
assert.ok(verificationCatch.includes("manual_reconciliation_required"));

const paymentPending = verified.slice(verified.indexOf("if (!paymentConfirmed)"), verified.indexOf("const { error: paymentPersistError }"));
assert.ok(paymentPending.includes("error: pendingPersistError"));
assert.ok(paymentPending.includes("error: attemptPendingPersistError"));
assert.ok(paymentPending.includes("if (pendingPersistError || attemptPendingPersistError)"));
assert.ok(paymentPending.includes("manual_reconciliation_required"));

const paymentConfirmed = verified.slice(verified.indexOf("const { error: paymentPersistError }"), verified.indexOf("return {\n    ...result,\n    succeeded: true"));
assert.ok(paymentConfirmed.includes("if (paymentPersistError)"));
assert.ok(paymentConfirmed.includes("error: attemptPaymentPersistError"));
assert.ok(paymentConfirmed.includes("if (attemptPaymentPersistError)"));
assert.ok(paymentConfirmed.includes("manual_reconciliation_required"));

const recordEvent = autonomous.slice(autonomous.indexOf("async function recordEvent"), autonomous.indexOf("/**\n * Autonomous order control plane"));
assert.ok(recordEvent.includes("if (error)"));
assert.ok(recordEvent.includes("throw new Error"));
assert.ok(!recordEvent.includes("AUDIT SKIPPED"));

assert.ok(attemptsMigration.includes("idempotency_key text not null unique"));
assert.ok(attemptsMigration.includes("purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade"));
assert.ok(verified.includes("manual_reconciliation_required"));
console.log("Supplier payment persistence / audit fail-closed contracts: 15 assertions passed");
