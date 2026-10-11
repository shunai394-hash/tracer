import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("lib/ordering/autonomous-control.ts", "utf8");
const paidOrderQuery = source.match(
  /\.from\("shop_orders"\)[\s\S]*?\.eq\("payment_status",\s*"paid"\)[\s\S]*?\.in\("order_status",\s*\[([^\]]+)\]\)/,
);
assert.ok(paidOrderQuery, "autonomous control must explicitly filter paid orders and allowed statuses");
assert.match(paidOrderQuery[1], /"placed"/);
assert.match(paidOrderQuery[1], /"processing"/);
assert.match(paidOrderQuery[1], /"fulfillment_pending"/);

// Run claims must fail closed before the paid-order loop when another worker
// owns the run key or the claim cannot be durably persisted.
assert.match(source, /automation_run_claim_lookup_failed/);
assert.match(source, /automation_run_already_claimed/);
assert.match(source, /automation_run_claim_lost/);
assert.match(source, /automation_run_claim_insert_failed/);
assert.match(source, /automation_run_finalization_failed/);
assert.doesNotMatch(source, /auditPersistence/);
assert.ok(
  source.indexOf('from("order_automation_runs")') < source.indexOf('from("shop_orders")'),
  "durable run claim must be acquired before loading orders",
);

assert.doesNotMatch(paidOrderQuery[1], /"cancelled"|"refunded"|"refund_pending"|"cancellation_requested"/);

const dropship = await readFile("lib/ordering/dropship.ts", "utf8");
assert.match(dropship, /String\(order\.payment_status\) !== "paid"/);
assert.match(dropship, /cancellation_requested.*refund_pending.*cancelled.*refunded/s);
assert.match(dropship, /idempotencyKey = `dropship:\$\{row\.id\}`/);

const shopifyOrdersRoute = await readFile("app/api/cron/shopify-orders/route.ts", "utf8");
assert.ok(shopifyOrdersRoute.includes('runAutonomousOrderControl(`shopify-orders:${new Date().toISOString().slice(0, 16)}`'));
assert.doesNotMatch(shopifyOrdersRoute, /slice\(0, 13\)/, "hour-scoped claims delay newly imported orders until the next hour");

console.log("Autonomous order eligibility checks passed: paid statuses included; unpaid/cancelled orders remain blocked; PO idempotency key is stable.");
