\set ON_ERROR_STOP on

-- Runs only in a fresh, disposable CI database.
create table public.internal_supply_products (
  id uuid primary key,
  source_name text not null,
  source_ref text not null,
  title text not null,
  active boolean not null default false
);

create table public.internal_supply_variants (
  id uuid primary key,
  supply_product_id uuid not null references public.internal_supply_products(id),
  variant_id text not null,
  variant_sku text,
  title text not null,
  inventory integer not null default 0
);

-- Reproduce the schema after the PR #152 migrations: legacy partial indexes
-- coexist with the full conflict-target indexes until PR #168 removes obsolete
-- uniqueness rules. This catches regressions where the old full SKU index survives.
create unique index internal_supply_products_source_ref_uq
  on public.internal_supply_products(source_name, source_ref) where source_ref is not null;
create unique index internal_supply_products_source_name_ref_atomic_uq
  on public.internal_supply_products(source_name, source_ref);
create unique index internal_supply_variants_product_variant_sku_uq
  on public.internal_supply_variants(supply_product_id, variant_sku) where variant_sku is not null;
create unique index internal_supply_variants_product_variant_id_uq
  on public.internal_supply_variants(supply_product_id, variant_id) where variant_id is not null;
create unique index internal_supply_variants_product_sku_atomic_uq
  on public.internal_supply_variants(supply_product_id, variant_sku);
create unique index internal_supply_variants_product_id_atomic_uq
  on public.internal_supply_variants(supply_product_id, variant_id);

\i supabase/migrations/20261010143000_tracer_internal_supply_conflict_targets.sql
-- The migration must be safe to re-apply in a disposable schema.
\i supabase/migrations/20261010143000_tracer_internal_supply_conflict_targets.sql

-- Audit table migration must be ordered after catalog conflict-target migration and repeatable.
\i supabase/migrations/20261010150000_tracer_internal_supply_ingestion_audit.sql
\i supabase/migrations/20261010150000_tracer_internal_supply_ingestion_audit.sql
do $$
begin
  if to_regclass('public.internal_supply_ingestion_audit') is null then
    raise exception 'internal supply ingestion audit table was not created';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='internal_supply_ingestion_audit' and column_name='catalog_id'
  ) then
    raise exception 'audit schema is missing catalog_id required by catalog sync';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='internal_supply_ingestion_audit' and column_name='bestseller_id'
  ) then
    raise exception 'audit schema is missing bestseller_id required by ingestion route';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='internal_supply_ingestion_audit'
      and indexname='internal_supply_ingestion_audit_request_item_uq'
  ) then
    raise exception 'audit schema is missing request_id/item_index unique target for upsert';
  end if;
end $;

-- SKU uniqueness must actually be gone, not merely hidden behind a differently named index.
do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname='public'
      and tablename='internal_supply_variants'
      and indexname in ('internal_supply_variants_product_variant_sku_uq','internal_supply_variants_product_sku_atomic_uq')
  ) then
    raise exception 'obsolete supplier SKU uniqueness index survived migration';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname='public'
      and tablename='internal_supply_variants'
      and indexname='internal_supply_variants_product_id_atomic_uq'
  ) then
    raise exception 'full variant-ID conflict target is missing';
  end if;
end $$;

do $$
declare
  v_product_id uuid := '10000000-0000-4000-8000-000000000001';
  v_variant_one uuid := '20000000-0000-4000-8000-000000000001';
  v_variant_two uuid := '20000000-0000-4000-8000-000000000002';
  v_product_count integer;
  v_variant_count integer;
  v_title text;
  v_inventory integer;
begin
  -- Product key is idempotent: retry updates one row, not duplicate products.
  insert into public.internal_supply_products(id, source_name, source_ref, title, active)
  values (v_product_id, 'cj', 'cj:product-1:variant-1', 'first title', false)
  on conflict (source_name, source_ref) do update
    set title = excluded.title, active = excluded.active;
  insert into public.internal_supply_products(id, source_name, source_ref, title, active)
  values ('10000000-0000-4000-8000-000000000003', 'cj', 'cj:product-1:variant-1', 'retry title', true)
  on conflict (source_name, source_ref) do update
    set title = excluded.title, active = excluded.active;
  select count(*), max(title) into v_product_count, v_title
    from public.internal_supply_products where source_name='cj' and source_ref='cj:product-1:variant-1';
  if v_product_count <> 1 or v_title <> 'retry title' then
    raise exception 'product upsert not idempotent: count %, title %', v_product_count, v_title;
  end if;

  -- Concrete variant ID is the conflict key. Duplicate supplier SKUs are allowed
  -- because sibling variants can legitimately share a SKU.
  insert into public.internal_supply_variants(id, supply_product_id, variant_id, variant_sku, title, inventory)
  values (v_variant_one, v_product_id, 'CJ-VARIANT-1', 'SHARED-SKU', 'variant one', 10)
  on conflict (supply_product_id, variant_id) do update
    set title = excluded.title, inventory = excluded.inventory;
  insert into public.internal_supply_variants(id, supply_product_id, variant_id, variant_sku, title, inventory)
  values (v_variant_two, v_product_id, 'CJ-VARIANT-2', 'SHARED-SKU', 'variant two', 20)
  on conflict (supply_product_id, variant_id) do update
    set title = excluded.title, inventory = excluded.inventory;

  -- Retrying the first variant updates it without changing the sibling.
  insert into public.internal_supply_variants(id, supply_product_id, variant_id, variant_sku, title, inventory)
  values ('20000000-0000-4000-8000-000000000009', v_product_id, 'CJ-VARIANT-1', 'SHARED-SKU', 'variant one retried', 11)
  on conflict (supply_product_id, variant_id) do update
    set title = excluded.title, inventory = excluded.inventory;

  select count(*) into v_variant_count from public.internal_supply_variants where supply_product_id=v_product_id;
  select title, inventory into v_title, v_inventory from public.internal_supply_variants
    where supply_product_id=v_product_id and variant_id='CJ-VARIANT-1';
  if v_variant_count <> 2 or v_title <> 'variant one retried' or v_inventory <> 11 then
    raise exception 'variant upsert/duplicate SKU contract failed: count %, title %, inventory %', v_variant_count, v_title, v_inventory;
  end if;
  if not exists(select 1 from public.internal_supply_variants where supply_product_id=v_product_id and variant_id='CJ-VARIANT-2' and inventory=20) then
    raise exception 'sibling variant was overwritten by retry';
  end if;

  raise notice 'PASS: migration ordering, duplicate SKU compatibility, product/variant upsert idempotency, and repeatability';
end $$;
