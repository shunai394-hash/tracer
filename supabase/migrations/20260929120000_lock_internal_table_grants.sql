-- Keep internal automation/order tables inaccessible to PostgREST roles.
-- Application server code uses service_role for these tables; anon/authenticated
-- must not retain TRUNCATE/TRIGGER/REFERENCES (or any table) privileges.
do $$
declare
  t text;
begin
  foreach t in array array[
    'purchase_orders','purchase_order_items','shop_orders','shop_order_items',
    'supplier_listings','shop_listings','marketplace_bestsellers',
    'cj_order_attempts','supplier_order_attempts','cron_runs','newfind_promotion_deliveries'
  ] loop
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
