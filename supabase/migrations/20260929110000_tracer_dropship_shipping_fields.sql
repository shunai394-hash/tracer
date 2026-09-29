-- Preserve the structured BASE shipping address needed by CJ live-order execution.
alter table public.shop_orders
  add column if not exists shipping_country_code text,
  add column if not exists shipping_province text,
  add column if not exists shipping_city text,
  add column if not exists shipping_line1 text,
  add column if not exists shipping_line2 text,
  add column if not exists shipping_zip text;

create index if not exists shop_orders_shipping_country_idx
  on public.shop_orders(shipping_country_code);
