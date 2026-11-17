-- Idempotent inventory reservations for TRACER-owned stock sold through Shopify.
-- This ledger is deliberately separate from supplier procurement and from the
-- legacy checkout reservation RPC. A Shopify line item can reserve stock once.

create table if not exists public.shopify_manual_stock_reservations (
  id uuid primary key default gen_random_uuid(),
  shopify_order_id text not null,
  shopify_line_item_id text not null,
  listing_id uuid not null references public.shop_listings(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'reserved'
    check (status in ('reserved', 'released')),
  reserved_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopify_manual_stock_reservations_line_unique unique (shopify_line_item_id),
  constraint shopify_manual_stock_reservations_release_state check (
    (status = 'reserved' and released_at is null)
    or (status = 'released' and released_at is not null)
  )
);

create index if not exists shopify_manual_stock_reservations_order_idx
  on public.shopify_manual_stock_reservations(shopify_order_id, status);

alter table public.shopify_manual_stock_reservations enable row level security;
revoke all on public.shopify_manual_stock_reservations from public, anon, authenticated;
grant all on public.shopify_manual_stock_reservations to service_role;

create or replace function public.reserve_shopify_manual_stock(
  p_shopify_order_id text,
  p_shopify_line_item_id text,
  p_listing_id uuid,
  p_quantity integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted_id uuid;
  existing public.shopify_manual_stock_reservations%rowtype;
begin
  if nullif(trim(p_shopify_order_id), '') is null
     or nullif(trim(p_shopify_line_item_id), '') is null
     or p_listing_id is null
     or p_quantity is null or p_quantity < 1 then
    raise exception 'invalid_manual_stock_reservation_arguments';
  end if;

  insert into public.shopify_manual_stock_reservations (
    shopify_order_id, shopify_line_item_id, listing_id, quantity
  ) values (
    trim(p_shopify_order_id), trim(p_shopify_line_item_id), p_listing_id, p_quantity
  )
  on conflict (shopify_line_item_id) do nothing
  returning id into inserted_id;

  if inserted_id is null then
    select * into existing
    from public.shopify_manual_stock_reservations
    where shopify_line_item_id = trim(p_shopify_line_item_id)
    for update;

    if not found
       or existing.shopify_order_id <> trim(p_shopify_order_id)
       or existing.listing_id <> p_listing_id
       or existing.quantity <> p_quantity then
      raise exception 'manual_stock_reservation_identity_conflict';
    end if;

    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'status', existing.status,
      'reservation_id', existing.id
    );
  end if;

  update public.shop_listings
  set inventory = inventory - p_quantity,
      updated_at = now()
  where id = p_listing_id
    and manual_inventory = true
    and published = true
    and archived_at is null
    and inventory >= p_quantity;

  if not found then
    raise exception 'manual_stock_unavailable';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'status', 'reserved',
    'reservation_id', inserted_id
  );
end;
$$;

create or replace function public.release_shopify_manual_stock(
  p_shopify_line_item_id text,
  p_reason text default 'shopify_cancelled_or_refunded'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  reservation public.shopify_manual_stock_reservations%rowtype;
begin
  if nullif(trim(p_shopify_line_item_id), '') is null then
    raise exception 'invalid_manual_stock_release_arguments';
  end if;

  select * into reservation
  from public.shopify_manual_stock_reservations
  where shopify_line_item_id = trim(p_shopify_line_item_id)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'reservation_not_found');
  end if;

  if reservation.status = 'released' then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'status', 'released',
      'reservation_id', reservation.id
    );
  end if;

  update public.shopify_manual_stock_reservations
  set status = 'released',
      released_at = now(),
      release_reason = left(coalesce(nullif(trim(p_reason), ''), 'unspecified'), 200),
      updated_at = now()
  where id = reservation.id
    and status = 'reserved';

  if not found then
    raise exception 'manual_stock_release_state_conflict';
  end if;

  update public.shop_listings
  set inventory = inventory + reservation.quantity,
      updated_at = now()
  -- Restore to the original TRACER-owned listing even if it was archived
  -- after sale; archival must not strand already-reserved physical stock.
  where id = reservation.listing_id
    and manual_inventory = true;

  if not found then
    raise exception 'manual_stock_listing_restore_failed';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'status', 'released',
    'reservation_id', reservation.id
  );
end;
$$;

revoke all on function public.reserve_shopify_manual_stock(text, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_shopify_manual_stock(text, text) from public, anon, authenticated;
grant execute on function public.reserve_shopify_manual_stock(text, text, uuid, integer) to service_role;
grant execute on function public.release_shopify_manual_stock(text, text) to service_role;
