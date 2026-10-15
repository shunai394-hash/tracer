-- Restore the Shopify order webhook contract in production.
-- Existing shop_order_items had only the base columns; the webhook writes the
-- supplier snapshot and Shopify line-item ID. Null IDs remain allowed for BASE
-- and older records; non-null Shopify line item IDs are unique and idempotent.
alter table public.shop_order_items
  add column if not exists supplier_listing_id uuid references public.supplier_listings(id) on delete set null,
  add column if not exists supplier_name text,
  add column if not exists supplier_product_id text,
  add column if not exists supplier_variant_id text,
  add column if not exists shopify_line_item_id text;

create unique index if not exists shop_order_items_shopify_line_item_id_unique
  on public.shop_order_items(shopify_line_item_id);

grant all privileges on table public.shop_order_items to service_role;
