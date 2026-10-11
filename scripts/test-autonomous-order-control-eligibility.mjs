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
assert.doesNotMatch(paidOrderQuery[1], /"cancelled"|"refunded"|"refund_pending"|"cancellation_requested"/);

const dropship = await readFile("lib/ordering/dropship.ts", "utf8");
assert.match(dropship, /String\(order\.payment_status\) !== "paid"/);
assert.match(dropship, /cancellation_requested.*refund_pending.*cancelled.*refunded/s);
assert.match(dropship, /idempotencyKey = `dropship:\$\{row\.id\}`/);

console.log("Autonomous order eligibility checks passed: paid statuses included; unpaid/cancelled orders remain blocked; PO idempotency key is stable.");
