import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [webhook, migration] = await Promise.all([
  readFile(new URL("../app/api/webhooks/stripe/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20261103090000_release_manual_inventory_once.sql", import.meta.url), "utf8"),
]);

assert.match(webhook, /checkout\.session\.expired/, "expired Checkout Sessions must release reserved stock");
assert.match(webhook, /checkout\.session\.async_payment_failed/, "terminal async payment failures must release reserved stock");
assert.match(webhook, /checkout\.session\.async_payment_succeeded/, "delayed successful payments must enter the paid fulfillment path");
assert.match(webhook, /release_manual_inventory_for_order/, "webhook must use the order-level idempotent release RPC");
assert.match(webhook, /processed_at\.lt\./, "duplicate webhook deliveries must acquire an expired processing lease atomically");
assert.match(webhook, /10 \* 60 \* 1000/, "failed webhook attempts must become retryable after the processing lease expires");
assert.match(webhook, /\.or\(\`processed_at\.is\.null,processed_at\.lt\.\$\{leaseExpiredAt\}\`\)/, "existing unprocessed events must use a conditional lease claim");
assert.match(webhook, /\.eq\("payment_status", "pending"\)[\s\S]*?\.eq\("order_status", "pending_payment"\)[\s\S]*?\.is\("manual_inventory_released_at", null\)/, "payment success must atomically compete with expiry release");
const paymentFailureStart = webhook.indexOf("async function handlePaymentFailed(");
const paymentFailureEnd = webhook.indexOf("\nasync function handleCheckoutSessionEnded", paymentFailureStart);
const paymentFailureHandler = webhook.slice(paymentFailureStart, paymentFailureEnd);
assert.ok(paymentFailureStart >= 0 && paymentFailureEnd > paymentFailureStart, "PaymentIntent failure handler must exist");
assert.doesNotMatch(paymentFailureHandler, /\.update\(/, "attempt-level card failures must not fail the order or release its reservation");

assert.match(migration, /for update/, "release RPC must lock the order row");
assert.match(migration, /manual_inventory_released_at is not null/, "release RPC must reject duplicate stock returns");
assert.match(migration, /payment_status not in \('pending', 'failed'\)/, "paid/refunded orders must never return reserved stock");
assert.match(migration, /order_status not in \('pending_payment', 'order_failed'\)/, "fulfilled or cancelled orders must never return reserved stock");
assert.match(migration, /release_manual_listing_stock\(item\.listing_id, item\.qty\)/, "release RPC must restore the exact reserved quantity");
assert.match(migration, /grant execute on function public\.release_manual_inventory_for_order\(uuid\) to service_role/, "only the server service role may call the release RPC");

console.log("TRACER Stripe manual inventory release contract tests passed");
