import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shopify = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
const stripe = await readFile(new URL("../app/api/webhooks/stripe/route.ts", import.meta.url), "utf8");

// Contract checks only: these do not connect to Supabase and are not DB integration tests.
assert.match(shopify, /shopify_line_item_id_missing/);
assert.match(shopify, /shopify_line_item_quantity_invalid/);
assert.match(shopify, /shopify_line_item_price_invalid/);
assert.match(shopify, /priorLines[\s\S]*?shopify_line_item_id/);
assert.match(shopify, /shopify_line_item_replay_conflict/);
assert.match(shopify, /insertedOrderId/);
assert.doesNotMatch(shopify, /if \(existing\.data\) return NextResponse\.json\(\{ ok: true, duplicate: true/);

assert.match(stripe, /stripe_event_ledger_update_failed/);
assert.match(stripe, /stripe_event_ledger_row_missing/);
assert.match(stripe, /stripe_refund_persistence_failed/);
console.log("Webhook replay contract checks passed (static source assertions; no database integration performed).");
