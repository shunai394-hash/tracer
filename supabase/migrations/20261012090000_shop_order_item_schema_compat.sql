alter table public.shop_order_items add column if not exists shopify_line_item_id text;
alter table public.shop_order_items add column if not exists supplier_listing_id uuid;
alter table public.shop_order_items add column if not exists supplier_name text;
alter table public.shop_order_items add column if not exists supplier_product_id text;
alter table public.shop_order_items add column if not exists supplier_variant_id text;
