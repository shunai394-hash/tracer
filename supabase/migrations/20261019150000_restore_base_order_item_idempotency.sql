-- Restore the BASE order-line idempotency contract used by
-- lib/channels/base-orders.ts. The original migration file exists in the
-- repository, but its version is absent from the production migration history
-- and the column/index are absent from the live schema.
-- Additive and safe for existing rows: existing rows receive NULL, and the
-- partial unique index only constrains non-NULL keys.

alter table public.shop_order_items
  add column if not exists base_order_item_key text;

create unique index if not exists shop_order_items_base_order_item_key_idx
  on public.shop_order_items(base_order_item_key)
  where base_order_item_key is not null;
