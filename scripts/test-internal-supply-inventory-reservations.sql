\set ON_ERROR_STOP on

-- Disposable CI database only. Never run against production.
do $$
begin
  create role anon;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role authenticated;
exception when duplicate_object then null;
end $$;
do $$
begin
  create role service_role;
exception when duplicate_object then null;
end $$;

create table public.purchase_orders (
  id uuid primary key
);
create table public.internal_supply_products (
  id uuid primary key,
  active boolean not null default true
);
create table public.internal_supply_variants (
  id uuid primary key,
  supply_product_id uuid not null references public.internal_supply_products(id),
  variant_id text,
  variant_sku text,
  title text,
  inventory integer,
  orderable boolean not null default false,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.tracer_supply_catalog (
  id uuid primary key,
  status text,
  inventory integer,
  orderable boolean,
  updated_at timestamptz not null default now()
);
create table public.tracer_supply_variants (
  id uuid primary key,
  catalog_id uuid not null references public.tracer_supply_catalog(id),
  internal_supply_variant_id uuid not null references public.internal_supply_variants(id),
  inventory integer,
  orderable boolean,
  updated_at timestamptz not null default now()
);
create table public.shop_listings (
  id uuid primary key,
  supplier_name text not null,
  supplier_variant_id text not null,
  inventory integer,
  orderable boolean,
  updated_at timestamptz not null default now()
);

\i supabase/migrations/20260929191000_tracer_internal_fulfillment_orders.sql
\i supabase/migrations/20260930070000_internal_supply_inventory_reservation.sql
\i supabase/migrations/20260930090000_fix_internal_supply_inventory_reservation_return_names.sql
\i supabase/migrations/20261012120000_internal_supply_reservation_ledger.sql

insert into public.internal_supply_products(id, active) values
 ('10000000-0000-4000-8000-000000000001', true),
 ('10000000-0000-4000-8000-000000000002', true);
insert into public.internal_supply_variants(id, supply_product_id, variant_id, variant_sku, title, inventory, orderable, active) values
 ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'v1', 'TEST-V1', 'Variant one', 10, true, true),
 ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'v2', 'TEST-V2', 'Variant two', 10, true, true);
insert into public.purchase_orders(id) values
 ('30000000-0000-4000-8000-000000000001'),
 ('30000000-0000-4000-8000-000000000002'),
 ('30000000-0000-4000-8000-000000000003'),
 ('30000000-0000-4000-8000-000000000004'),
 ('30000000-0000-4000-8000-000000000005'),
 ('30000000-0000-4000-8000-000000000006'),
 ('30000000-0000-4000-8000-000000000007');
insert into public.tracer_supply_catalog(id, status, inventory, orderable) values
 ('40000000-0000-4000-8000-000000000001', 'ready', 10, true),
 ('40000000-0000-4000-8000-000000000002', 'ready', 10, true);
insert into public.tracer_supply_variants(id, catalog_id, internal_supply_variant_id, inventory, orderable) values
 ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 10, true),
 ('50000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 10, true);
insert into public.shop_listings(id, supplier_name, supplier_variant_id, inventory, orderable) values
 ('60000000-0000-4000-8000-000000000001', 'TRACER_INTERNAL', '20000000-0000-4000-8000-000000000001', 10, true),
 ('60000000-0000-4000-8000-000000000002', 'TRACER_INTERNAL', '20000000-0000-4000-8000-000000000002', 10, true);

-- Database-level guard: an internal fulfillment order cannot be inserted
-- unless its purchase order has an active matching inventory reservation.
do $$
declare
  v_failed boolean := false;
begin
  begin
    insert into public.internal_fulfillment_orders(
      purchase_order_id, supply_product_id, supply_variant_id, quantity, status, order_number
    ) values (
      '30000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002',
      1, 'reserved', 'unreserved-order'
    );
  exception when others then
    v_failed := sqlerrm = 'internal_fulfillment_requires_active_reservation';
    if not v_failed then raise; end if;
  end;
  if not v_failed then raise exception 'unreserved internal fulfillment order was accepted'; end if;
end $$;

-- Inject allocation failure. The variant update and ledger insert must both
-- roll back; the same PO remains available for the later concurrency test.
create function public.inject_inventory_allocation_failure()
returns trigger language plpgsql as $$
begin
  raise exception 'injected_inventory_allocation_failure';
end $$;
create trigger injected_inventory_allocation_failure
before update on public.internal_supply_variants
for each row execute function public.inject_inventory_allocation_failure();

do $$
declare
  v_failed boolean := false;
  v_inventory integer;
begin
  begin
    perform public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000002', 4
    );
  exception when others then
    if sqlerrm = 'injected_inventory_allocation_failure' then
      v_failed := true;
    else
      raise;
    end if;
  end;

  if not v_failed then raise exception 'injected inventory allocation failure did not fire'; end if;
  select inventory into v_inventory from public.internal_supply_variants where id='20000000-0000-4000-8000-000000000002';
  if v_inventory <> 10 then raise exception 'failed allocation changed inventory'; end if;
  if exists(select 1 from public.internal_supply_inventory_reservations where purchase_order_id='30000000-0000-4000-8000-000000000003') then
    raise exception 'failed allocation left a reservation ledger row';
  end if;
end $$;

drop trigger injected_inventory_allocation_failure on public.internal_supply_variants;
drop function public.inject_inventory_allocation_failure();

-- Reserve once; repeated calls for the same PO must not decrement again.
do $$
declare
  v_remaining integer;
  v_status text;
begin
  select remaining_inventory, reservation_status into v_remaining, v_status
    from public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 3
    );
  if v_remaining <> 7 or v_status <> 'reserved' then
    raise exception 'first reservation incorrect: %, %', v_remaining, v_status;
  end if;

  select remaining_inventory, reservation_status into v_remaining, v_status
    from public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 3
    );
  if v_remaining <> 7 or v_status <> 'reserved' then
    raise exception 'idempotent reservation decremented twice: %, %', v_remaining, v_status;
  end if;

  begin
    perform public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 4
    );
    raise exception 'reservation identity conflict was accepted';
  exception when others then
    if sqlerrm = 'reservation identity conflict was accepted' then raise; end if;
    if sqlerrm <> 'reservation_identity_conflict' then raise; end if;
  end;
end $$;

-- Inject projection failure during compensation. The stock and ledger must
-- roll back together; a retry after removing the fault returns stock once.
create function public.inject_catalog_projection_failure()
returns trigger language plpgsql as $$
begin
  raise exception 'injected_catalog_projection_failure';
end $$;
create trigger injected_catalog_projection_failure
before update on public.tracer_supply_catalog
for each row execute function public.inject_catalog_projection_failure();

do $$
declare
  v_failed boolean := false;
  v_inventory integer;
  v_status text;
begin
  begin
    perform public.release_internal_supply_reservation(
      '30000000-0000-4000-8000-000000000001',
      'inventory_projection_failed'
    );
  exception when others then
    if sqlerrm = 'injected_catalog_projection_failure' then
      v_failed := true;
    else
      raise;
    end if;
  end;

  if not v_failed then raise exception 'injected projection failure did not fire'; end if;
  select inventory into v_inventory from public.internal_supply_variants where id='20000000-0000-4000-8000-000000000001';
  select status into v_status from public.internal_supply_inventory_reservations where purchase_order_id='30000000-0000-4000-8000-000000000001';
  if v_inventory <> 7 or v_status <> 'reserved' then
    raise exception 'failed release was not atomic: inventory %, status %', v_inventory, v_status;
  end if;
end $$;

drop trigger injected_catalog_projection_failure on public.tracer_supply_catalog;
drop function public.inject_catalog_projection_failure();

-- The failed-order return is valid only after the internal order is terminal.
insert into public.internal_fulfillment_orders(
  purchase_order_id, supply_product_id, supply_variant_id, quantity, status, order_number
) values (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  3, 'failed', 'dropship:30000000-0000-4000-8000-000000000001'
);

do $
declare
  v_status text;
begin
  select status into v_status from public.internal_supply_inventory_reservations
   where purchase_order_id='30000000-0000-4000-8000-000000000001';
  if v_status <> 'committed' then
    raise exception 'successful internal order did not commit its reservation: %', v_status;
  end if;
end $;

do $
declare
  v_inventory integer;
  v_status text;
  v_reason text;
begin
  select restored_inventory, reservation_status into v_inventory, v_status
    from public.release_internal_supply_reservation(
      '30000000-0000-4000-8000-000000000001',
      'supplier_status_failed'
    );
  if v_inventory <> 10 or v_status <> 'released_now' then
    raise exception 'release after failure incorrect: inventory %, status %', v_inventory, v_status;
  end if;

  select restored_inventory, reservation_status into v_inventory, v_status
    from public.release_internal_supply_reservation(
      '30000000-0000-4000-8000-000000000001',
      'supplier_status_failed'
    );
  if v_inventory <> 10 or v_status <> 'released' then
    raise exception 'double release changed inventory: %, %', v_inventory, v_status;
  end if;

  select release_reason into v_reason from public.internal_supply_inventory_reservations
   where purchase_order_id='30000000-0000-4000-8000-000000000001';
  if v_reason <> 'supplier_status_failed' then
    raise exception 'terminal release reason was not recorded: %', v_reason;
  end if;

  select reservation_status into v_status
    from public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001', 3
    );
  if v_status <> 'released' then raise exception 'released reservation was re-opened'; end if;
  select inventory into v_inventory from public.internal_supply_variants where id='20000000-0000-4000-8000-000000000001';
  if v_inventory <> 10 then raise exception 'retry after release consumed stock again'; end if;
end $$;

-- A cancelled order returns its stock once and records a distinct reason.
do $$
declare
  v_inventory integer;
  v_status text;
  v_reason text;
begin
  select remaining_inventory into v_inventory
    from public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000006',
      '20000000-0000-4000-8000-000000000001', 1
    );
  if v_inventory <> 9 then raise exception 'cancelled-order reservation incorrect'; end if;

  insert into public.internal_fulfillment_orders(
    purchase_order_id, supply_product_id, supply_variant_id, quantity, status, order_number
  ) values (
    '30000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    1, 'cancelled', 'dropship:30000000-0000-4000-8000-000000000006'
  );

  select restored_inventory, reservation_status into v_inventory, v_status
    from public.release_internal_supply_reservation(
      '30000000-0000-4000-8000-000000000006',
      'supplier_status_cancelled'
    );
  if v_inventory <> 10 or v_status <> 'released_now' then
    raise exception 'cancelled-order release incorrect: inventory %, status %', v_inventory, v_status;
  end if;
  select release_reason into v_reason from public.internal_supply_inventory_reservations
   where purchase_order_id='30000000-0000-4000-8000-000000000006';
  if v_reason <> 'supplier_status_cancelled' then
    raise exception 'cancelled-order release reason was not recorded: %', v_reason;
  end if;
end $$;

-- A live internal order must not release stock, even if a caller supplies a
-- terminal-looking reason. Once it actually becomes failed, stock returns once.
do $$
declare
  v_inventory integer;
  v_status text;
begin
  select remaining_inventory into v_inventory
    from public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000007',
      '20000000-0000-4000-8000-000000000001', 2
    );
  if v_inventory <> 8 then raise exception 'active-order reservation incorrect'; end if;

  insert into public.internal_fulfillment_orders(
    purchase_order_id, supply_product_id, supply_variant_id, quantity, status, order_number
  ) values (
    '30000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    2, 'reserved', 'dropship:30000000-0000-4000-8000-000000000007'
  );

  select restored_inventory, reservation_status into v_inventory, v_status
    from public.release_internal_supply_reservation(
      '30000000-0000-4000-8000-000000000007', 'supplier_status_failed'
    );
  if v_inventory <> 8 or v_status <> 'active_order' then
    raise exception 'active order released stock: inventory %, status %', v_inventory, v_status;
  end if;

  update public.internal_fulfillment_orders set status='failed'
   where purchase_order_id='30000000-0000-4000-8000-000000000007';
  select restored_inventory, reservation_status into v_inventory, v_status
    from public.release_internal_supply_reservation(
      '30000000-0000-4000-8000-000000000007', 'supplier_status_failed'
    );
  if v_inventory <> 10 or v_status <> 'released_now' then
    raise exception 'failed active order did not release stock once: inventory %, status %', v_inventory, v_status;
  end if;
end $$;

-- Inject order-row creation failure after reservation, then compensate once.
create function public.inject_internal_order_insert_failure()
returns trigger language plpgsql as $$
begin
  raise exception 'injected_internal_order_insert_failure';
end $$;
create trigger injected_internal_order_insert_failure
before insert on public.internal_fulfillment_orders
for each row execute function public.inject_internal_order_insert_failure();

do $$
declare
  v_remaining integer;
  v_status text;
  v_failed boolean := false;
begin
  select remaining_inventory into v_remaining
    from public.reserve_internal_supply_for_order(
      '30000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002', 2
    );
  if v_remaining <> 8 then raise exception 'reservation before injected insert failure incorrect'; end if;

  begin
    insert into public.internal_fulfillment_orders(
      purchase_order_id, supply_product_id, supply_variant_id, quantity, status, order_number
    ) values (
      '30000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000002', 2, 'reserved', 'dropship:30000000-0000-4000-8000-000000000002'
    );
  exception when others then
    if sqlerrm = 'injected_internal_order_insert_failure' then
      v_failed := true;
    else
      raise;
    end if;
  end;

  if not v_failed then raise exception 'injected order insert failure did not fire'; end if;
  select reservation_status into v_status
    from public.release_internal_supply_reservation(
      '30000000-0000-4000-8000-000000000002',
      'internal_fulfillment_order_insert_failed'
    );
  if v_status <> 'released_now' then raise exception 'order creation compensation did not release reservation'; end if;
  select inventory into v_remaining from public.internal_supply_variants where id='20000000-0000-4000-8000-000000000002';
  if v_remaining <> 10 then raise exception 'order creation compensation did not restore inventory'; end if;
end $$;

drop trigger injected_internal_order_insert_failure on public.internal_fulfillment_orders;
drop function public.inject_internal_order_insert_failure();

select 'PASS: idempotent reservation, identity conflict, injected projection/order failures, atomic compensation, and double-release prevention' as result;
