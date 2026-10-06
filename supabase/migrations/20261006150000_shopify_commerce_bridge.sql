-- Shopify becomes the customer-facing commerce surface while TRACER remains
-- the product intelligence and procurement control plane.
-- Additive only; existing storefront/order fields remain intact.

alter table public.shop_listings
  add column if not exists shopify_product_id text,
  add column if not exists shopify_variant_id text,
  add column if not exists shopify_status text,
  add column if not exists shopify_last_synced_at timestamptz,
  add column if not exists shopify_last_error text;

create unique index if not exists shop_listings_shopify_product_idx
  on public.shop_listings(shopify_product_id)
  where shopify_product_id is not null;

alter table public.shop_orders
  add column if not exists shopify_order_id text,
  add column if not exists shopify_order_number text,
  add column if not exists shopify_financial_status text,
  add column if not exists shopify_fulfillment_status text;

create unique index if not exists shop_orders_shopify_order_idx
  on public.shop_orders(shopify_order_id)
  where shopify_order_id is not null;

alter table public.shop_order_items
  add column if not exists shopify_line_item_id text;

create index if not exists shop_order_items_shopify_line_item_idx
  on public.shop_order_items(shopify_line_item_id)
  where shopify_line_item_id is not null;

grant all privileges on table public.shop_orders to service_role;
grant all privileges on table public.shop_order_items to service_role;
grant all privileges on table public.shop_listings to service_role;
