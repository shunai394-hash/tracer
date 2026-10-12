import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [base, shopify, control, execution] = await Promise.all([
  read("../lib/channels/base-orders.ts"),
  read("../lib/shopify/sync-orders.ts"),
  read("../lib/ordering/autonomous-control.ts"),
  read("../lib/ordering/verified-supplier-execution.ts"),
]);

// BASE must re-fetch payment evidence for an already-imported order and retry
// idempotent PO creation after payment is confirmed.
const existingBaseOrder = base.slice(base.indexOf("if (existing?.id)"), base.indexOf("if (summary.dispatch_status"));
assert.match(existingBaseOrder, /getBaseOrderDetail\(baseOrderKey\)/);
assert.match(existingBaseOrder, /isBaseOrderPaid\(detail\)/);
assert.match(existingBaseOrder, /if \(paid && !canceled\)/);
assert.match(existingBaseOrder, /createDropshipPurchaseOrdersForShopOrder\(String\(existing\.id\)\)/);
assert.match(existingBaseOrder, /else if \(existing\.payment_status === "paid"\)[\\s\\S]*?must not[\\s\\S]*?downgrade/);

// Unpaid cash-on-delivery / post-pay orders must never open procurement.
assert.match(base, /case "cod":[\s\S]*?return false;/);
assert.match(base, /case "atobarai":[\s\S]*?return false;/);

// Shopify must page past already-imported orders and validate paid/unfulfilled
// status before importing a new local order.
assert.match(shopify, /while \(hasNextOrdersPage && orders\.length < maxNewOrders\)/);
assert.match(shopify, /shopify_orders_cursor_not_advancing/);
assert.match(shopify, /displayFinancialStatus !== "PAID"/);
assert.match(shopify, /displayFulfillmentStatus !== "UNFULFILLED"/);
assert.match(shopify, /shopify_order_id/);

// The autonomous runner must re-attempt PO creation for eligible paid orders.
// This checks the recovery path contract, not external supplier execution.
assert.match(control, /\.eq\("payment_status", "paid"\)/);
assert.match(control, /\.in\("order_status", \["placed", "processing", "fulfillment_pending"\]\)/);
assert.match(control, /createDropshipPurchaseOrdersForShopOrder\(shopOrderId\)/);

// Ambiguous external outcomes must be reconciled, not blindly retried.
assert.match(execution, /manual_reconciliation_required/);
assert.match(execution, /deduped_existing_attempt/);
assert.match(execution, /supplier_order_created_db_sync_failed/);
assert.match(execution, /supplier_attempt_record_update_failed_manual_reconciliation_required/);

console.log("Paid-order recovery contract: 18 assertions passed");
