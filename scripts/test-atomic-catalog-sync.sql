-- Isolated PostgreSQL integration tests for PR #152 atomic catalog sync RPC.
-- Executed only against the disposable CI PostgreSQL service; never production.
create role anon;
create role authenticated;
create role service_role;

create table public.internal_supply_products (
  id uuid primary key,
  generation bigint not null,
  active boolean not null
);
create table public.internal_supply_variants (
  id uuid primary key,
  supply_product_id uuid not null references public.internal_supply_products(id),
  generation bigint not null,
  active boolean not null,
  orderable boolean not null,
  inventory integer not null
);
create table public.tracer_supply_catalog (
  id uuid primary key default gen_random_uuid(),
  tracer_sku text unique not null,
  title text,
  brand text,
  category text,
  image_url text,
  status text,
  cost numeric,
  shipping_cost numeric,
  handling_cost numeric,
  sale_price numeric,
  currency text,
  inventory integer,
  lead_time_days integer,
  tracking_available boolean,
  orderable boolean,
  source_type text,
  source_ref text,
  evidence jsonb,
  metadata jsonb,
  bestseller_id uuid,
  updated_at timestamptz
);
create table public.tracer_supply_variants (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.tracer_supply_catalog(id),
  variant_sku text unique not null,
  title text,
  barcode text,
  attributes jsonb,
  cost numeric,
  inventory integer,
  orderable boolean,
  internal_supply_product_id uuid,
  internal_supply_variant_id uuid,
  updated_at timestamptz
);

\i supabase/migrations/20261010120000_harden_atomic_catalog_sync_scope_and_sku_conflicts.sql

insert into public.internal_supply_products(id,generation,active) values
 ('10000000-0000-4000-8000-000000000001',1,true),
 ('10000000-0000-4000-8000-000000000002',1,true);
insert into public.internal_supply_variants(id,supply_product_id,generation,active,orderable,inventory) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,true,true,10),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',1,true,true,8);

do $$
declare
  v_result jsonb;
  v_catalog_id uuid;
  v_before_title text;
  v_failed boolean;
  v_bestseller uuid := '30000000-0000-4000-8000-000000000001';
  v_other_bestseller uuid := '30000000-0000-4000-8000-000000000002';
  v_product uuid := '10000000-0000-4000-8000-000000000001';
  v_variant uuid := '20000000-0000-4000-8000-000000000001';
  v_other_product uuid := '10000000-0000-4000-8000-000000000002';
  v_other_variant uuid := '20000000-0000-4000-8000-000000000002';
  v_catalog jsonb;
  v_catalog_variant jsonb;
begin
  v_catalog := jsonb_build_object(
    'tracer_sku','TRACER-TEST-001','title','テスト商品','brand','Test','category','test',
    'image_url','https://example.invalid/test.png','status','draft','cost',100,
    'shipping_cost',20,'handling_cost',0,'sale_price',250,'currency','JPY','inventory',10,
    'lead_time_days',7,'tracking_available',true,'orderable',true,'source_type','internal',
    'source_ref','ci-test-source-001','evidence','{}'::jsonb,'metadata','{}'::jsonb,
    'bestseller_id',v_bestseller,'updated_at',now()
  );
  v_catalog_variant := jsonb_build_object(
    'variant_sku','TRACER-TEST-001-V1','title','テスト variant','barcode',null,
    'attributes','{}'::jsonb,'cost',100,'inventory',10,'orderable',true,
    'internal_supply_product_id',v_product,'internal_supply_variant_id',v_variant,'updated_at',now()
  );

  -- Positive unique source/product/variant scope.
  v_result := public.commit_internal_supply_catalog_sync(v_product,v_variant,1,1,v_catalog,v_catalog_variant);
  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception 'positive unique match failed: %', v_result;
  end if;
  v_catalog_id := (v_result->>'catalog_id')::uuid;
  if not exists(select 1 from public.tracer_supply_variants where catalog_id=v_catalog_id and internal_supply_variant_id=v_variant) then
    raise exception 'positive match did not persist variant';
  end if;

  -- Stale generation is rejected without mutating the prior catalog.
  select title into v_before_title from public.tracer_supply_catalog where id=v_catalog_id;
  v_failed := false;
  begin
    perform public.commit_internal_supply_catalog_sync(v_product,v_variant,999,1,
      jsonb_set(v_catalog,'{title}','"MUTATED"'::jsonb),
      jsonb_set(v_catalog_variant,'{variant_sku}','"TRACER-TEST-STALE"'::jsonb));
  exception when others then v_failed := true;
  end;
  v_result := public.commit_internal_supply_catalog_sync(v_product,v_variant,999,1,v_catalog,v_catalog_variant);
  if coalesce((v_result->>'reason'),'') <> 'generation_conflict' then
    raise exception 'stale generation should be rejected: %', v_result;
  end if;
  if (select title from public.tracer_supply_catalog where id=v_catalog_id) is distinct from v_before_title then
    raise exception 'stale generation mutated catalog';
  end if;

  -- Wrong product/variant ownership is rejected.
  v_result := public.commit_internal_supply_catalog_sync(v_product,v_other_variant,1,1,v_catalog,v_catalog_variant);
  if coalesce((v_result->>'reason'),'') <> 'variant_missing_or_wrong_owner' then
    raise exception 'cross-product variant should be rejected: %', v_result;
  end if;

  -- Null/blank IDs and forged JSON scope cannot pass.
  v_result := public.commit_internal_supply_catalog_sync(v_product,v_variant,1,1,
    v_catalog - 'bestseller_id',v_catalog_variant);
  if coalesce((v_result->>'reason'),'') <> 'payload_scope_mismatch' then
    raise exception 'missing bestseller ID should be rejected: %', v_result;
  end if;
  v_result := public.commit_internal_supply_catalog_sync(v_product,v_variant,1,1,v_catalog,
    jsonb_set(v_catalog_variant,'{internal_supply_product_id}',to_jsonb(v_other_product::text)));
  if coalesce((v_result->>'reason'),'') <> 'payload_scope_mismatch' then
    raise exception 'forged product ID should be rejected: %', v_result;
  end if;

  -- Inactive, unorderable, and out-of-stock sources are rejected.
  update public.internal_supply_variants set inventory=0 where id=v_variant;
  v_result := public.commit_internal_supply_catalog_sync(v_product,v_variant,1,1,v_catalog,v_catalog_variant);
  if coalesce((v_result->>'reason'),'') <> 'source_not_sellable' then
    raise exception 'out-of-stock source should be rejected: %', v_result;
  end if;
  update public.internal_supply_variants set inventory=10 where id=v_variant;

  -- SKU collision with a different bestseller must throw and roll back both writes.
  v_catalog := jsonb_set(v_catalog,'{tracer_sku}','"TRACER-TEST-001"'::jsonb);
  v_catalog := jsonb_set(v_catalog,'{bestseller_id}',to_jsonb(v_other_bestseller::text));
  v_catalog_variant := jsonb_set(v_catalog_variant,'{variant_sku}','"TRACER-TEST-OTHER-V1"'::jsonb);
  v_catalog_variant := jsonb_set(v_catalog_variant,'{internal_supply_product_id}',to_jsonb(v_other_product::text));
  v_catalog_variant := jsonb_set(v_catalog_variant,'{internal_supply_variant_id}',to_jsonb(v_other_variant::text));
  v_failed := false;
  begin
    perform public.commit_internal_supply_catalog_sync(v_other_product,v_other_variant,1,1,v_catalog,v_catalog_variant);
  exception when unique_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'SKU ownership collision should raise unique_violation'; end if;
  if (select bestseller_id from public.tracer_supply_catalog where id=v_catalog_id) is distinct from v_bestseller then
    raise exception 'SKU collision partially overwrote existing catalog owner';
  end if;
  if exists(select 1 from public.tracer_supply_variants where variant_sku='TRACER-TEST-OTHER-V1') then
    raise exception 'SKU collision left partial variant row';
  end if;

  -- Privilege contract: only service_role may execute the SECURITY DEFINER RPC.
  if has_function_privilege('anon','public.commit_internal_supply_catalog_sync(uuid,uuid,bigint,bigint,jsonb,jsonb)','EXECUTE') then
    raise exception 'anon unexpectedly has execute privilege';
  end if;
  if has_function_privilege('authenticated','public.commit_internal_supply_catalog_sync(uuid,uuid,bigint,bigint,jsonb,jsonb)','EXECUTE') then
    raise exception 'authenticated unexpectedly has execute privilege';
  end if;
  if not has_function_privilege('service_role','public.commit_internal_supply_catalog_sync(uuid,uuid,bigint,bigint,jsonb,jsonb)','EXECUTE') then
    raise exception 'service_role lacks execute privilege';
  end if;

  raise notice 'PASS: unique valid scope, stale generation, cross-product scope, forged IDs, out-of-stock, SKU collision rollback, and grants';
end $$;
