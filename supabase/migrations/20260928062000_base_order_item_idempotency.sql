-- Make each BASE order line independently idempotent.
-- This prevents duplicate shop_order_items during concurrent polling and
-- allows a partially imported order to be safely repaired on retry.
alter table public.shop_order_items
  add column if not exists base_order_item_key text;

create unique index if not exists shop_order_items_base_order_item_key_idx
  on public.shop_order_items(base_order_item_key)
  where base_order_item_key is not null;
