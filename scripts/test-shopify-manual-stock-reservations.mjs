import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../supabase/migrations/20261117093000_shopify_manual_stock_idempotent_reservations.sql", import.meta.url),
  "utf8",
);

assert.match(migration, /unique \(shopify_line_item_id\)/, "one Shopify line item may create only one reservation");
assert.match(migration, /enable row level security/, "reservation ledger must have RLS enabled");
assert.match(migration, /revoke all on public\.shopify_manual_stock_reservations from public, anon, authenticated/, "reservation ledger must not be publicly accessible");
assert.match(migration, /on conflict \(shopify_line_item_id\) do nothing/, "replayed paid webhooks must not insert another reservation");
assert.match(migration, /existing\.shopify_order_id <> trim\(p_shopify_order_id\)/, "reused line IDs with a different order must fail closed");
assert.match(migration, /existing\.listing_id <> p_listing_id/, "reused line IDs with a different listing must fail closed");
assert.match(migration, /existing\.quantity <> p_quantity/, "reused line IDs with a different quantity must fail closed");
assert.match(migration, /for update/, "concurrent duplicate reservation/release calls must serialize on the reservation row");
assert.match(migration, /inventory = inventory - p_quantity/, "reservation must decrement the exact quantity");
assert.match(migration, /manual_inventory = true[\s\S]*published = true[\s\S]*archived_at is null[\s\S]*inventory >= p_quantity/, "reservation must require active published manual stock and sufficient inventory");
assert.match(migration, /raise exception 'manual_stock_unavailable'/, "insufficient stock must abort the reservation transaction");
assert.match(migration, /where shopify_line_item_id = trim\(p_shopify_line_item_id\)[\s\S]*status = 'reserved'/, "release must locate and transition only the original reservation");
assert.match(migration, /status = 'released'[\s\S]*released_at = now\(\)/, "release must leave an auditable terminal state");
assert.match(migration, /inventory = inventory \+ reservation\.quantity/, "release must restore the reserved quantity exactly once");
assert.match(migration, /where id = reservation\.listing_id[\\s\\S]*and manual_inventory = true;/, "release must restore the original listing even if it was archived after reservation");
assert.match(migration, /grant execute on function public\.reserve_shopify_manual_stock\(text, text, uuid, integer\) to service_role/, "only service_role may reserve Shopify manual stock");
assert.match(migration, /grant execute on function public\.release_shopify_manual_stock\(text, text\) to service_role/, "only service_role may release Shopify manual stock");

console.log("TRACER Shopify manual stock reservation contract tests passed");
