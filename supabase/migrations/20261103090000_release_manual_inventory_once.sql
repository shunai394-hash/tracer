-- Return TRACER-owned stock exactly once when a Stripe Checkout Session
-- reaches a terminal state without payment.
alter table public.shop_orders
  add column if not exists manual_inventory_released_at timestamptz;

create or replace function public.release_manual_inventory_for_order(p_order_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_order public.shop_orders%rowtype;
  item record;
  updated_rows integer;
begin
  select * into target_order
  from public.shop_orders
  where id = p_order_id
  for update;

  if not found
     or target_order.manual_inventory_released_at is not null
     or target_order.payment_status not in ('pending', 'failed')
     or target_order.order_status not in ('pending_payment', 'order_failed') then
    return false;
  end if;

  update public.shop_orders
  set manual_inventory_released_at = now(),
      payment_status = 'failed',
      order_status = 'cancelled',
      cancelled_at = coalesce(cancelled_at, now())
  where id = p_order_id;

  for item in
    select i.listing_id, sum(i.qty)::integer as qty
    from public.shop_order_items i
    join public.shop_listings l on l.id = i.listing_id
    where i.order_id = p_order_id
      and l.manual_inventory = true
    group by i.listing_id
  loop
    update public.shop_listings
    set inventory = inventory + item.qty,
        updated_at = now()
    where id = item.listing_id
      and manual_inventory = true;

    get diagnostics updated_rows = row_count;
    if updated_rows <> 1 then
      raise exception 'Manual inventory listing % was not restored', item.listing_id;
    end if;
  end loop;

  return true;
end;
$$;

revoke all on function public.release_manual_inventory_for_order(uuid) from public, anon, authenticated;
grant execute on function public.release_manual_inventory_for_order(uuid) to service_role;
