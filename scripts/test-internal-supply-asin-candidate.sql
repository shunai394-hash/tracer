-- Disposable PostgreSQL integration test for the ASIN candidate lookup migration.
\set ON_ERROR_STOP on
drop table if exists public.internal_supply_variants cascade;
drop table if exists public.internal_supply_products cascade;
create table public.internal_supply_products (
  id uuid primary key default gen_random_uuid(),
  active boolean not null default true
);
create table public.internal_supply_variants (
  id uuid primary key default gen_random_uuid(),
  active boolean not null default true
);
\i supabase/migrations/20261011070000_internal_supply_asin_candidate_lookup.sql
-- Idempotency: a second application must succeed without duplicate-column/index errors.
\i supabase/migrations/20261011070000_internal_supply_asin_candidate_lookup.sql
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='internal_supply_products' and column_name='asin' and data_type='text'
  ) then raise exception 'internal_supply_products.asin missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='internal_supply_variants' and column_name='asin' and data_type='text'
  ) then raise exception 'internal_supply_variants.asin missing'; end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='internal_supply_products_asin_active_idx') then
    raise exception 'internal_supply_products_asin_active_idx missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='internal_supply_variants_asin_active_idx') then
    raise exception 'internal_supply_variants_asin_active_idx missing';
  end if;
end $$;
select 'PASS: ASIN lookup migration is additive and idempotent' as result;
