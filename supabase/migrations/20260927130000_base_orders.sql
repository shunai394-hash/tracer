alter table public.shop_orders
  add column if not exists base_order_key text,
  add column if not exists base_order_synced_at timestamptz;

create unique index if not exists shop_orders_base_order_key_idx
  on public.shop_orders(base_order_key)
  where base_order_key is not null;
