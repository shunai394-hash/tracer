-- Immutable supplier snapshot for each customer-order line.
-- Order fulfillment must not change when a published shop listing is refreshed.
alter table public.shop_order_items
  add column if not exists supplier_listing_id uuid,
  add column if not exists supplier_name text,
  add column if not exists supplier_product_id text,
  add column if not exists supplier_variant_id text;

create index if not exists shop_order_items_supplier_listing_idx
  on public.shop_order_items(supplier_listing_id);

grant all privileges on table public.shop_order_items to service_role;
