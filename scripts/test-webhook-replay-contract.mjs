import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shopify = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
const stripe = await readFile(new URL("../app/api/webhooks/stripe/route.ts", import.meta.url), "utf8");
const paidWebhook = await readFile(new URL("../app/api/webhooks/shopify/orders-paid/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/20261012160000_shopify_line_item_idempotency.sql", import.meta.url), "utf8");

// Contract checks only: these do not connect to Supabase and are not DB integration tests.
assert.match(shopify, /shopify_line_item_id_missing/);
assert.match(shopify, /shopify_line_item_quantity_invalid/);
assert.match(shopify, /shopify_line_item_price_invalid/);
assert.match(shopify, /priorLines[\s\S]*?shopify_line_item_id/);
assert.match(shopify, /shopify_line_item_replay_conflict/);
assert.match(shopify, /shopify_line_item_id_duplicate/);
assert.match(shopify, /onConflict: "order_id,shopify_line_item_id", ignoreDuplicates: true/);
assert.match(migration, /create unique index if not exists shop_order_items_order_shopify_line_unique_idx/);
assert.match(migration, /shopify_line_item_idempotency_preflight_failed/);
assert.match(shopify, /insertedOrderId/);
assert.doesNotMatch(shopify, /if \(existing\.data\) return NextResponse\.json\(\{ ok: true, duplicate: true/);

assert.match(paidWebhook, /prior\.processed === true/);
assert.match(paidWebhook, /retryingUnprocessedEvent = true/);
assert.match(paidWebhook, /imported\.failed > 0/);
assert.match(paidWebhook, /shopify_webhook_event_mark_processed_failed/);
assert.match(paidWebhook, /shopify_webhook_event_missing_when_marking_processed/);
assert.match(stripe, /stripe_event_ledger_update_failed/);
assert.match(stripe, /stripe_event_ledger_row_missing/);
assert.match(stripe, /stripe_refund_persistence_failed/);
console.log("Webhook replay contract checks passed (static source assertions only; no DB concurrency/integration test performed).");
