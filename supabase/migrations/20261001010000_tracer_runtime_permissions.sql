-- Runtime cron workers use the Supabase service role. Keep the grants
-- explicit for the tables introduced by the autonomous supply/order pipeline.
grant usage on schema public to service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'internal_supply_products',
    'internal_supply_variants',
    'internal_fulfillment_orders',
    'order_automation_runs',
    'purchase_orders',
    'supplier_order_attempts',
    'supplier_listings',
    'shop_listings',
    'shop_orders',
    'shop_order_items',
    'cron_runs'
  ]
  loop
    if to_regclass('public.' || table_name) is not null then
      execute format('grant all privileges on table public.%I to service_role', table_name);
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema public to service_role;

alter table if exists public.purchase_orders
  add column if not exists fulfillment_kind text not null default 'inventory_reorder';

alter table if exists public.purchase_orders
  drop constraint if exists purchase_orders_fulfillment_kind_check;

alter table if exists public.purchase_orders
  add constraint purchase_orders_fulfillment_kind_check
  check (fulfillment_kind in ('inventory_reorder', 'dropship_customer_order'));
