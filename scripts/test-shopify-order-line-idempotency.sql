\set ON_ERROR_STOP on

-- This file runs only against a disposable CI database.
drop table if exists public.shop_order_items cascade;
create table public.shop_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  shopify_line_item_id text
);

\ir ../supabase/migrations/20261011110000_shopify_order_line_idempotency.sql

insert into public.shop_order_items(order_id, shopify_line_item_id)
values
  ('00000000-0000-0000-0000-000000000001', 'gid://shopify/LineItem/101'),
  ('00000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000002', 'gid://shopify/LineItem/101');

do $$
begin
  begin
    insert into public.shop_order_items(order_id, shopify_line_item_id)
    values ('00000000-0000-0000-0000-000000000001', 'gid://shopify/LineItem/101');
    raise exception 'expected duplicate Shopify line-item key to be rejected';
  exception
    when unique_violation then
      null;
  end;
end
$$;

do $$
begin
  if (select count(*) from public.shop_order_items where shopify_line_item_id is null) <> 2 then
    raise exception 'legacy/null Shopify line-item rows should remain allowed';
  end if;
  if (select count(*) from public.shop_order_items where shopify_line_item_id = 'gid://shopify/LineItem/101') <> 2 then
    raise exception 'same external line-item ID on distinct orders should remain allowed by the order-scoped index';
  end if;
end
$$;

\echo 'Shopify order-line unique-index migration integration test passed.'
