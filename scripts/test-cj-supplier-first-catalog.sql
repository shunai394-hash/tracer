-- Disposable PostgreSQL regression test for NULL-safe CJ source provenance.
-- Executed only against the CI-only tracer_cj_stage_test database; never production.
do $roles$
begin
  create role anon;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role authenticated;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role service_role;
exception when duplicate_object then null;
end
$roles$;

create table public.internal_supply_products (
  id uuid primary key, source_name text, active boolean, generation bigint,
  fetched_at timestamptz, metadata jsonb, source_ref text, brand text,
  cost numeric, shipping_cost numeric, currency text, lead_time_days integer,
  tracking_available boolean
);
create table public.internal_supply_variants (
  id uuid primary key, supply_product_id uuid not null references public.internal_supply_products(id),
  source_name text, active boolean, generation bigint, fetched_at timestamptz,
  metadata jsonb, variant_id text, title text, cost numeric, shipping_cost numeric,
  currency text, inventory integer, tracking_available boolean
);
create table public.tracer_supply_catalog (
  id uuid primary key default gen_random_uuid(), tracer_sku text unique not null,
  title text, brand text, category text, image_url text, status text, cost numeric,
  shipping_cost numeric, handling_cost numeric, sale_price numeric, currency text,
  inventory integer, lead_time_days integer, tracking_available boolean, orderable boolean,
  source_type text, source_ref text, evidence jsonb, metadata jsonb, bestseller_id uuid,
  updated_at timestamptz
);
create table public.tracer_supply_variants (
  id uuid primary key default gen_random_uuid(), catalog_id uuid not null references public.tracer_supply_catalog(id),
  variant_sku text unique not null, title text, barcode text, attributes jsonb, cost numeric,
  inventory integer, orderable boolean, internal_supply_product_id uuid,
  internal_supply_variant_id uuid, updated_at timestamptz
);

\i supabase/migrations/20261014100000_cj_supplier_first_draft_catalog.sql

insert into public.internal_supply_products
  (id,source_name,active,generation,fetched_at,metadata,source_ref,brand,cost,shipping_cost,currency,lead_time_days,tracking_available)
values
  ('10000000-0000-4000-8000-000000000001',null,true,1,now(),
   '{"supplier_product_id":"P-NULL-PRODUCT"}','cj:P-NULL-PRODUCT:V-1','Test',10,2,'USD',7,true),
  ('10000000-0000-4000-8000-000000000002','cj',true,1,now(),
   '{"supplier_product_id":"P-NULL-VARIANT"}','cj:P-NULL-VARIANT:V-2','Test',10,2,'USD',7,true);

insert into public.internal_supply_variants
  (id,supply_product_id,source_name,active,generation,fetched_at,metadata,variant_id,title,cost,shipping_cost,currency,inventory,tracking_available)
values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','cj',true,1,now(),
   '{"supplier_variant_id":"V-1"}','V-1','Null product source',10,2,'USD',5,true),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',null,true,1,now(),
   '{"supplier_variant_id":"V-2"}','V-2','Null variant source',10,2,'USD',5,true);

do $$
declare v_result jsonb;
begin
  v_result := public.stage_cj_supplier_first_catalog_draft(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',1,1);
  if coalesce(v_result->>'reason','') <> 'not_active_cj_supply' then
    raise exception 'NULL product source_name was not rejected: %', v_result;
  end if;

  v_result := public.stage_cj_supplier_first_catalog_draft(
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',1,1);
  if coalesce(v_result->>'reason','') <> 'not_active_cj_supply' then
    raise exception 'NULL variant source_name was not rejected: %', v_result;
  end if;

  if exists(select 1 from public.tracer_supply_catalog)
     or exists(select 1 from public.tracer_supply_variants) then
    raise exception 'NULL source provenance unexpectedly staged catalog records';
  end if;

  if has_function_privilege('anon','public.stage_cj_supplier_first_catalog_draft(uuid,uuid,bigint,bigint)','EXECUTE')
     or has_function_privilege('authenticated','public.stage_cj_supplier_first_catalog_draft(uuid,uuid,bigint,bigint)','EXECUTE')
     or not has_function_privilege('service_role','public.stage_cj_supplier_first_catalog_draft(uuid,uuid,bigint,bigint)','EXECUTE') then
    raise exception 'Unexpected draft RPC execution grants';
  end if;

  raise notice 'PASS: NULL product and variant source_name rejected before any catalog write';
end $$;
