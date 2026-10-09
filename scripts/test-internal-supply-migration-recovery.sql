\set ON_ERROR_STOP on

-- Disposable PostgreSQL only. This suite intentionally reproduces a failed
-- source-ownership migration and verifies repair + re-application succeeds.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
alter role service_role bypassrls;

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

insert into public.internal_supply_products(id,source_name,source_ref,title) values
 ('10000000-0000-4000-8000-000000000001','cj','cj:p1','CJ product one'),
 ('10000000-0000-4000-8000-000000000002','cj','cj:p2','CJ product two');
insert into public.internal_supply_variants(id,supply_product_id,variant_id,variant_sku,title) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','DUPLICATE-CJ-VARIANT','SKU-1','first duplicate'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','DUPLICATE-CJ-VARIANT','SKU-2','second duplicate');

-- The migration should detect duplicate source+variant ownership and stop
-- before installing the unique index. psql continues only to inspect the
-- partial state produced by statement-by-statement migration execution.
\set ON_ERROR_STOP off
\i supabase/migrations/20261010152000_tracer_internal_supply_variant_source_ownership.sql
\set ON_ERROR_STOP on

do $$
begin
  if exists (
    select 1 from pg_indexes
     where schemaname='public' and tablename='internal_supply_variants'
       and indexname='internal_supply_variants_source_name_variant_id_uq'
  ) then
    raise exception 'failed migration unexpectedly created ownership unique index';
  end if;
  if not exists (
    select 1 from public.internal_supply_variants
     where source_name='cj' and variant_id='DUPLICATE-CJ-VARIANT'
    group by source_name,variant_id having count(*)=2
  ) then
    raise exception 'duplicate fixture was not preserved after failed migration';
  end if;
end $$;

-- Resolve the duplicate manually and re-run the same migration.
delete from public.internal_supply_variants
 where id='20000000-0000-4000-8000-000000000002';
\i supabase/migrations/20261010152000_tracer_internal_supply_variant_source_ownership.sql
\i supabase/migrations/20261010152000_tracer_internal_supply_variant_source_ownership.sql

do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname='public' and tablename='internal_supply_variants'
       and indexname='internal_supply_variants_source_name_variant_id_uq'
  ) then
    raise exception 'ownership unique index missing after repair/retry';
  end if;
  if (select count(*) from pg_trigger
       where tgrelid='public.internal_supply_variants'::regclass
         and tgname='internal_supply_variants_set_source_name'
         and not tgisinternal) <> 1 then
    raise exception 'source ownership trigger missing or duplicated after retry';
  end if;
end $$;

-- Ownership must be derived from the actual parent, not caller-supplied source_name.
insert into public.internal_supply_variants(
  id,supply_product_id,variant_id,variant_sku,title,inventory,source_name
) values (
  '20000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  'CJ-NEW-VARIANT','SKU-NEW','new variant',5,'forged-other-supplier'
);
do $$
begin
  if (select source_name from public.internal_supply_variants
       where id='20000000-0000-4000-8000-000000000003') <> 'cj' then
    raise exception 'caller-supplied source_name overrode the parent supplier';
  end if;
end $$;

-- A missing parent must be rejected, not turned into an orphan variant.
do $$
declare
  v_rejected boolean := false;
begin
  begin
    insert into public.internal_supply_variants(
      id,supply_product_id,variant_id,variant_sku,title,inventory,source_name
    ) values (
      '20000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000099',
      'ORPHAN-VARIANT','ORPHAN-SKU','orphan',1,'cj'
    );
  exception when foreign_key_violation then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'variant without a parent product was accepted'; end if;
end $$;

-- Reproduce a legacy audit table whose old CHECK constraint rejects the current
-- status vocabulary. Existing rows must survive and their old status be retained.
create table public.internal_supply_ingestion_audit (
  id bigserial primary key,
  source_name text,
  source_ref text,
  outcome text not null constraint legacy_audit_outcome_check
    check (outcome in ('queued','success','error')),
  created_at timestamptz not null default now()
);
insert into public.internal_supply_ingestion_audit(source_name,source_ref,outcome) values
 ('cj','legacy:queued','queued'),
 ('cj','legacy:success','success'),
 ('cj','legacy:error','error');

\i supabase/migrations/20261010150000_tracer_internal_supply_ingestion_audit.sql
-- A second run verifies idempotent repair of a partially upgraded schema.
\i supabase/migrations/20261010150000_tracer_internal_supply_ingestion_audit.sql

do $$
declare
  v_count integer;
  v_unique_requests integer;
  v_queued text;
  v_success text;
  v_error text;
begin
  select count(*),count(distinct request_id)
    into v_count,v_unique_requests
    from public.internal_supply_ingestion_audit;
  if v_count <> 3 or v_unique_requests <> 3 then
    raise exception 'legacy audit rows lost or request IDs not uniquely backfilled: rows %, unique requests %',v_count,v_unique_requests;
  end if;
  select outcome,details->>'legacy_outcome_before_migration'
    into v_queued,v_error
    from public.internal_supply_ingestion_audit where source_ref='legacy:queued';
  if v_queued <> 'started' or v_error <> 'queued' then
    raise exception 'queued legacy audit status not safely normalized/preserved: %, %',v_queued,v_error;
  end if;
  select outcome into v_success from public.internal_supply_ingestion_audit where source_ref='legacy:success';
  if v_success <> 'synced' then raise exception 'success legacy audit status was not normalized: %',v_success; end if;
  select outcome into v_error from public.internal_supply_ingestion_audit where source_ref='legacy:error';
  if v_error <> 'failed' then raise exception 'error legacy audit status was not normalized: %',v_error; end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid='public.internal_supply_ingestion_audit'::regclass
       and conname='internal_supply_ingestion_audit_outcome_check'
  ) then raise exception 'canonical audit outcome constraint missing'; end if;
  if not (select relrowsecurity from pg_class where oid='public.internal_supply_ingestion_audit'::regclass) then
    raise exception 'audit RLS is not enabled';
  end if;
  if has_table_privilege('anon','public.internal_supply_ingestion_audit','SELECT')
     or has_table_privilege('anon','public.internal_supply_ingestion_audit','INSERT')
     or has_table_privilege('authenticated','public.internal_supply_ingestion_audit','SELECT')
     or has_table_privilege('authenticated','public.internal_supply_ingestion_audit','INSERT') then
    raise exception 'anon/authenticated unexpectedly has audit table access';
  end if;
  if not has_table_privilege('service_role','public.internal_supply_ingestion_audit','INSERT')
     or not has_table_privilege('service_role','public.internal_supply_ingestion_audit','UPDATE')
     or not has_table_privilege('service_role','public.internal_supply_ingestion_audit','SELECT') then
    raise exception 'service_role lacks required audit table privileges';
  end if;
end $$;

-- Exercise an update against migrated legacy rows and an actual service_role write.
update public.internal_supply_ingestion_audit
   set outcome='sync_blocked'
 where source_ref='legacy:queued';
set role service_role;
insert into public.internal_supply_ingestion_audit(source_name,source_ref,outcome)
values ('cj','service-role-write','synced');
reset role;

do $$
begin
  if (select count(*) from public.internal_supply_ingestion_audit) <> 4 then
    raise exception 'audit update/write caused data loss or unexpected duplication';
  end if;
  if not exists (
    select 1 from public.internal_supply_ingestion_audit
     where source_ref='legacy:queued' and outcome='sync_blocked'
       and details->>'legacy_outcome_before_migration'='queued'
  ) then raise exception 'legacy audit evidence was not preserved after update'; end if;
  if not exists (
    select 1 from public.internal_supply_ingestion_audit
     where source_ref='service-role-write' and outcome='synced'
  ) then raise exception 'service_role audit insert failed'; end if;
end $$;

\echo 'PASS: migration failure recovery, source ownership trigger/FK, legacy audit constraint upgrade, row retention, grants, and rerun idempotency'
