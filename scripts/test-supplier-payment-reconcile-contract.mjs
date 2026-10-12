import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, recovery] = await Promise.all([
  readFile(new URL("../lib/ordering/reconcile.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/ordering/supplier-payment-recovery.ts", import.meta.url), "utf8"),
]);
assert.match(source, /"supplier_payment_pending", "supplier_payment_verification_failed"/);
assert.match(source, /currentStatus === "supplier_payment_pending" \|\| currentStatus === "supplier_payment_verification_failed"/);
assert.match(source, /recoverSupplierPaymentState\(/);
assert.match(source, /orderStatusSupported: Boolean\(adapter\.capabilities\.orderStatus\)/);
assert.match(source, /adapter\.getOrderStatus\(id\)/);
assert.doesNotMatch(source, /executeSupplierPurchaseOrder\s*\(/,
  "payment recovery must not invoke the supplier order creation path");
assert.match(recovery, /paymentResult\?\.paymentConfirmed === true/);
assert.match(recovery, /supplier_order_attempt_ledger_missing_manual_reconciliation_required/);
assert.match(recovery, /supplier_payment_attempt_ledger_update/);
assert.match(recovery, /supplier_payment_purchase_order_update/);
assert.match(recovery, /supplier_payment_pending_evidence_update/);
assert.match(recovery, /if \(attempt\.error\) throw new Error/);
assert.match(recovery, /if \(persisted\.error\) throw new Error/);
assert.match(recovery, /if \(!persisted\.data\) throw new Error/);
assert.match(recovery, /recovery_source: "supplier_status_reconciliation"/);
console.log("Supplier payment reconciliation contract: 15 assertions passed");
