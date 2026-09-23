-- Links a customer shop order to a purchase order so a real CJ order can be placed
-- against a real shipping address. Structured address fields are required for live
-- ordering; the free-text shipping_address stays for display/back-compat.
-- Additive only.

alter table public.shop_orders
  add column if not exists shipping_country_code text;

alter table public.shop_orders
  add column if not exists shipping_province text;

alter table public.shop_orders
  add column if not exists shipping_city text;

alter table public.shop_orders
  add column if not exists shipping_zip text;

alter table public.shop_orders
  add column if not exists shipping_line1 text;

alter table public.purchase_orders
  add column if not exists shop_order_id uuid references public.shop_orders(id) on delete set null;

alter table public.purchase_orders
  add column if not exists fulfillment_kind text not null default 'inventory_reorder'
  check (fulfillment_kind in ('inventory_reorder', 'dropship_customer_order'));

create index if not exists purchase_orders_shop_order_idx
  on public.purchase_orders(shop_order_id);

alter table public.purchase_order_items
  add column if not exists cj_variant_id text;

alter table public.supplier_listings
  add column if not exists cj_variant_id text;
