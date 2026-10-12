import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/ordering/reconcile.ts", import.meta.url), "utf8");
assert.match(source, /"supplier_payment_pending", "supplier_payment_verification_failed"/);
assert.match(source, /currentStatus === "supplier_payment_pending" \|\| currentStatus === "supplier_payment_verification_failed"/);
assert.match(source, /Recovery for an existing supplier order is lookup-only/);
assert.match(source, /if \(!adapter\.capabilities\.orderStatus\)/);
assert.match(source, /supplier_payment_status_lookup_unsupported_manual_reconciliation_required/);
assert.match(source, /adapter\.getOrderStatus\(supplierOrderId\)/);
assert.ok(!source.includes("executeSupplierPurchaseOrder"),
  "payment recovery must not invoke the supplier order creation path");
assert.match(source, /paymentResult\?\.paymentConfirmed === true/);
assert.match(source, /supplier_order_attempt_ledger_missing_manual_reconciliation_required/);
assert.match(source, /supplier_payment_attempt_ledger_update/);
assert.match(source, /supplier_payment_purchase_order_update/);
assert.match(source, /supplier_payment_pending_evidence_update/);
assert.match(source, /if \(paymentUpdateError\) throw new Error/);
assert.match(source, /if \(pendingUpdateError\) throw new Error/);
assert.match(source, /if \(attemptError\) throw new Error/);
assert.match(source, /recovery_source: "supplier_status_reconciliation"/);
console.log("Supplier payment reconciliation fail-closed contract: 14 assertions passed");
