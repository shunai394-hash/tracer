-- Idempotent, order-keyed inventory reservations for TRACER internal fulfillment.
-- A purchase order can reserve inventory at most once and release it at most once.
create table if not exists public.internal_supply_inventory_reservations (
  purchase_order_id uuid primary key references public.purchase_orders(id) on delete restrict,
  variant_id uuid not null references public.internal_supply_variants(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'reserved' check (status in ('reserved', 'released')),
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists internal_supply_inventory_reservations_variant_status_idx
  on public.internal_supply_inventory_reservations(variant_id, status);

create or replace function public.reserve_internal_supply_for_order(
  p_purchase_order_id uuid,
  p_variant_id uuid,
  p_quantity integer
)
returns table(variant_id uuid, remaining_inventory integer, reservation_status text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing record;
  v_remaining integer;
begin
  if p_purchase_order_id is null or p_variant_id is null then
    raise exception 'reservation_identity_required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive';
  end if;

  -- Serialize retries for one purchase order even before a ledger row exists.
  perform pg_advisory_xact_lock(hashtextextended(p_purchase_order_id::text, 0));

  select r.variant_id, r.quantity, r.status
    into v_existing
    from public.internal_supply_inventory_reservations r
   where r.purchase_order_id = p_purchase_order_id
   for update;

  if found then
    if v_existing.variant_id is distinct from p_variant_id
       or v_existing.quantity is distinct from p_quantity then
      raise exception 'reservation_identity_conflict';
    end if;

    select v.inventory into v_remaining
      from public.internal_supply_variants v
     where v.id = p_variant_id;

    if v_existing.status = 'released' then
      return query select p_variant_id, v_remaining, 'released'::text;
      return;
    end if;

    return query select p_variant_id, v_remaining, 'reserved'::text;
    return;
  end if;

  update public.internal_supply_variants v
     set inventory = v.inventory - p_quantity,
         orderable = (v.inventory - p_quantity) > 0,
         updated_at = now()
   where v.id = p_variant_id
     and v.active = true
     and v.orderable = true
     and v.inventory is not null
     and v.inventory >= p_quantity
  returning v.inventory into v_remaining;

  if not found then
    return;
  end if;

  insert into public.internal_supply_inventory_reservations(
    purchase_order_id, variant_id, quantity, status
  ) values (
    p_purchase_order_id, p_variant_id, p_quantity, 'reserved'
  );

  return query select p_variant_id, v_remaining, 'reserved'::text;
end;
$$;

create or replace function public.release_internal_supply_reservation(
  p_purchase_order_id uuid,
  p_reason text default null
)
returns table(variant_id uuid, restored_inventory integer, reservation_status text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_reservation record;
  v_restored integer;
  v_order_status text;
  v_order_exists boolean := false;
  v_compensation_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if p_purchase_order_id is null then
    raise exception 'reservation_identity_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_purchase_order_id::text, 0));

  select r.variant_id, r.quantity, r.status
    into v_reservation
    from public.internal_supply_inventory_reservations r
   where r.purchase_order_id = p_purchase_order_id
   for update;

  if not found then
    return query select null::uuid, null::integer, 'missing'::text;
    return;
  end if;

  if v_reservation.status = 'released' then
    select v.inventory into v_restored
      from public.internal_supply_variants v
     where v.id = v_reservation.variant_id;
    return query select v_reservation.variant_id, v_restored, 'released'::text;
    return;
  end if;

  select o.status into v_order_status
    from public.internal_fulfillment_orders o
   where o.purchase_order_id = p_purchase_order_id
   for update;
  v_order_exists := found;

  if v_order_exists and v_order_status not in ('failed', 'cancelled') then
    select v.inventory into v_restored
      from public.internal_supply_variants v
     where v.id = v_reservation.variant_id;
    return query select v_reservation.variant_id, v_restored, 'active_order'::text;
    return;
  end if;

  if not v_order_exists and v_compensation_reason not in (
    'reservation_projection_invalid',
    'inventory_projection_failed',
    'internal_fulfillment_order_insert_failed'
  ) then
    select v.inventory into v_restored
      from public.internal_supply_variants v
     where v.id = v_reservation.variant_id;
    return query select v_reservation.variant_id, v_restored, 'compensation_not_allowed'::text;
    return;
  end if;

  update public.internal_supply_variants v
     set inventory = coalesce(v.inventory, 0) + v_reservation.quantity,
         orderable = v.active and (coalesce(v.inventory, 0) + v_reservation.quantity) > 0,
         updated_at = now()
   where v.id = v_reservation.variant_id
  returning v.inventory into v_restored;

  if not found then
    raise exception 'reserved_variant_missing';
  end if;

  update public.internal_supply_inventory_reservations
     set status = 'released',
         release_reason = nullif(trim(coalesce(p_reason, '')), ''),
         updated_at = now()
   where purchase_order_id = p_purchase_order_id
     and status = 'reserved';

  -- Keep internal catalog/listing projections aligned with the canonical stock.
  update public.tracer_supply_variants
     set inventory = v_restored,
         orderable = v_restored > 0,
         updated_at = now()
   where internal_supply_variant_id = v_reservation.variant_id;

  update public.tracer_supply_catalog c
     set inventory = v_restored,
         orderable = v_restored > 0,
         status = case when v_restored > 0 then 'ready' else 'draft' end,
         updated_at = now()
   where c.id in (
     select distinct tv.catalog_id
       from public.tracer_supply_variants tv
      where tv.internal_supply_variant_id = v_reservation.variant_id
   );

  update public.shop_listings
     set inventory = v_restored,
         orderable = v_restored > 0,
         updated_at = now()
   where supplier_name = 'TRACER_INTERNAL'
     and supplier_variant_id = v_reservation.variant_id::text;

  return query select v_reservation.variant_id, v_restored, 'released_now'::text;
end;
$$;

revoke all on function public.reserve_internal_supply_for_order(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_internal_supply_reservation(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_internal_supply_for_order(uuid, uuid, integer) to service_role;
grant execute on function public.release_internal_supply_reservation(uuid, text) to service_role;
