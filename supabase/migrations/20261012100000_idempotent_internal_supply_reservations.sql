-- Idempotent inventory reservations and compensation for TRACER internal fulfillment.
-- A reservation is keyed by the supplier idempotency key, so retries cannot deduct or return stock twice.

create table if not exists public.internal_supply_inventory_reservations (
  reservation_key text primary key,
  variant_id uuid not null references public.internal_supply_variants(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  state text not null default 'reserved' check (state in ('reserved','committed','released')),
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz
);

create index if not exists internal_supply_inventory_reservations_state_idx
  on public.internal_supply_inventory_reservations(state, updated_at);

-- Remove the legacy non-idempotent signatures so callers cannot accidentally use them.
drop function if exists public.reserve_internal_supply_variant(uuid, integer);
drop function if exists public.release_internal_supply_variant(uuid, integer);

create or replace function public.reserve_internal_supply_variant(
  p_reservation_key text,
  p_variant_id uuid,
  p_quantity integer
)
returns table(variant_id uuid, remaining_inventory integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inserted_key text;
  v_reservation public.internal_supply_inventory_reservations%rowtype;
  v_remaining integer;
begin
  if p_reservation_key is null or length(trim(p_reservation_key)) = 0 then
    raise exception 'reservation_key_required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive';
  end if;

  insert into public.internal_supply_inventory_reservations(reservation_key, variant_id, quantity, state)
  values (p_reservation_key, p_variant_id, p_quantity, 'reserved')
  on conflict (reservation_key) do nothing
  returning reservation_key into v_inserted_key;

  if v_inserted_key is null then
    select * into v_reservation
      from public.internal_supply_inventory_reservations
     where reservation_key = p_reservation_key
     for update;
    if not found then
      return;
    end if;
    if v_reservation.variant_id <> p_variant_id or v_reservation.quantity <> p_quantity then
      raise exception 'reservation_idempotency_conflict';
    end if;
    if v_reservation.state <> 'reserved' then
      return;
    end if;
    select v.inventory into v_remaining
      from public.internal_supply_variants v
     where v.id = p_variant_id;
    if not found then
      raise exception 'reservation_variant_missing';
    end if;
    return query select p_variant_id, v_remaining;
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
    delete from public.internal_supply_inventory_reservations r
     where r.reservation_key = p_reservation_key and r.state = 'reserved';
    return;
  end if;

  return query select p_variant_id, v_remaining;
end;
$$;

create or replace function public.commit_internal_supply_variant_reservation(
  p_reservation_key text,
  p_variant_id uuid,
  p_quantity integer
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
begin
  if not exists (
    select 1 from public.internal_fulfillment_orders o
     where o.order_number = p_reservation_key
       and o.supply_variant_id = p_variant_id
       and o.quantity = p_quantity
  ) then
    return false;
  end if;

  update public.internal_supply_inventory_reservations r
     set state = 'committed', updated_at = now()
   where r.reservation_key = p_reservation_key
     and r.variant_id = p_variant_id
     and r.quantity = p_quantity
     and r.state = 'reserved';
  if found then return true; end if;

  select r.state into v_state
    from public.internal_supply_inventory_reservations r
   where r.reservation_key = p_reservation_key
     and r.variant_id = p_variant_id
     and r.quantity = p_quantity;
  return v_state = 'committed';
end;
$$;

create or replace function public.release_internal_supply_variant(
  p_reservation_key text,
  p_variant_id uuid,
  p_quantity integer,
  p_reason text default 'compensation'
)
returns table(variant_id uuid, restored_inventory integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_reservation public.internal_supply_inventory_reservations%rowtype;
  v_order_status text;
  v_restored integer;
  v_order_exists boolean := false;
begin
  if p_reservation_key is null or length(trim(p_reservation_key)) = 0 then
    raise exception 'reservation_key_required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive';
  end if;

  select * into v_reservation
    from public.internal_supply_inventory_reservations r
   where r.reservation_key = p_reservation_key
   for update;
  if not found then return; end if;
  if v_reservation.variant_id <> p_variant_id or v_reservation.quantity <> p_quantity then
    raise exception 'reservation_idempotency_conflict';
  end if;
  if v_reservation.state = 'released' then return; end if;

  select o.status into v_order_status
    from public.internal_fulfillment_orders o
   where o.order_number = p_reservation_key
     and o.supply_variant_id = p_variant_id
     and o.quantity = p_quantity
   for update;
  v_order_exists := found;

  if v_order_exists and v_order_status not in ('failed','cancelled') then
    update public.internal_supply_inventory_reservations
       set state = 'committed', updated_at = now()
     where reservation_key = p_reservation_key and state = 'reserved';
    return;
  end if;

  -- If an internal order exists, stock is returned only after its authoritative
  -- status is failed/cancelled. If no order exists, this is compensation for a
  -- failed order-creation path and only an uncommitted reservation may be returned.
  if not v_order_exists and v_reservation.state <> 'reserved' then
    return;
  end if;

  update public.internal_supply_variants v
     set inventory = coalesce(v.inventory, 0) + p_quantity,
         orderable = v.active and (coalesce(v.inventory, 0) + p_quantity) > 0,
         updated_at = now()
   where v.id = p_variant_id
  returning v.inventory into v_restored;
  if not found then
    raise exception 'reservation_variant_missing';
  end if;

  update public.internal_supply_inventory_reservations r
     set state = 'released',
         release_reason = coalesce(nullif(trim(p_reason), ''), 'unspecified'),
         released_at = now(),
         updated_at = now()
   where r.reservation_key = p_reservation_key;

  return query select p_variant_id, v_restored;
end;
$$;

create or replace function public.assert_internal_fulfillment_reservation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
begin
  select r.state into v_state
    from public.internal_supply_inventory_reservations r
   where r.reservation_key = new.order_number
     and r.variant_id = new.supply_variant_id
     and r.quantity = new.quantity
   for update;
  if not found then
    raise exception 'internal_fulfillment_requires_active_inventory_reservation';
  end if;
  if v_state = 'committed' and exists (
    select 1 from public.internal_fulfillment_orders o where o.order_number = new.order_number
  ) then
    -- Permit the duplicate insert to reach the unique constraint so the caller
    -- can re-read the already-created order without releasing its reservation.
    return new;
  end if;
  if v_state <> 'reserved' then
    raise exception 'internal_fulfillment_requires_active_inventory_reservation';
  end if;
  return new;
end;
$$;

drop trigger if exists internal_fulfillment_requires_reservation on public.internal_fulfillment_orders;
create trigger internal_fulfillment_requires_reservation
before insert on public.internal_fulfillment_orders
for each row execute function public.assert_internal_fulfillment_reservation();

revoke all on function public.reserve_internal_supply_variant(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.commit_internal_supply_variant_reservation(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_internal_supply_variant(text, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.assert_internal_fulfillment_reservation() from public, anon, authenticated;
grant execute on function public.reserve_internal_supply_variant(text, uuid, integer) to service_role;
grant execute on function public.commit_internal_supply_variant_reservation(text, uuid, integer) to service_role;
grant execute on function public.release_internal_supply_variant(text, uuid, integer, text) to service_role;
