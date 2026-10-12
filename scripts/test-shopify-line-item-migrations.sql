\set ON_ERROR_STOP on
begin;

drop table if exists public.shop_order_items cascade;
create table public.shop_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
);

\i supabase/migrations/20261012090000_shop_order_item_schema_compat.sql

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shop_order_items'
      and column_name = 'shopify_line_item_id' and data_type = 'text'
  ) then raise exception 'shopify_line_item_id column missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shop_order_items'
      and column_name = 'supplier_listing_id' and data_type = 'uuid'
  ) then raise exception 'supplier_listing_id column missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shop_order_items'
      and column_name = 'supplier_name' and data_type = 'text'
  ) then raise exception 'supplier_name column missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shop_order_items'
      and column_name = 'supplier_product_id' and data_type = 'text'
  ) then raise exception 'supplier_product_id column missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shop_order_items'
      and column_name = 'supplier_variant_id' and data_type = 'text'
  ) then raise exception 'supplier_variant_id column missing'; end if;
end $$;

insert into public.shop_order_items (order_id, shopify_line_item_id)
values (gen_random_uuid(), 'line-item-100');

\i supabase/migrations/20261012100000_shopify_line_item_idempotency.sql

do $$
begin
  begin
    insert into public.shop_order_items (order_id, shopify_line_item_id)
    values (gen_random_uuid(), 'line-item-100');
    raise exception 'duplicate Shopify line item unexpectedly accepted';
  exception when unique_violation then
    null;
  end;
end $$;

rollback;
