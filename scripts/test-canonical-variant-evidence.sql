-- Disposable PostgreSQL test for canonical marketplace child-variant evidence.
-- This script is only run against the isolated CI database, never production.
create table if not exists public.marketplace_bestsellers (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  title text not null,
  source text not null
);

\i supabase/migrations/20261010170000_marketplace_bestseller_variants.sql
\i supabase/migrations/20261010170000_marketplace_bestseller_variants.sql

insert into public.marketplace_bestsellers(id, marketplace, title, source)
values ('30000000-0000-4000-8000-000000000001', 'amazon.co.jp', 'Variant fixture parent', 'ci_fixture')
on conflict (id) do nothing;

insert into public.marketplace_bestseller_variants(
  bestseller_id, marketplace, source, source_variant_id, sku, title,
  gtin, evidence_source, raw_evidence, fetched_at
)
values (
  '30000000-0000-4000-8000-000000000001', 'amazon.co.jp', 'ci_fixture',
  'B0VARIANT01', 'SKU-1', 'Variant fixture', '4006381333931',
  'schema_org_product_group_has_variant',
  '{"parent_barcode_not_inherited":true}'::jsonb, now()
)
on conflict (bestseller_id, source_variant_id) do update
set gtin = excluded.gtin, raw_evidence = excluded.raw_evidence, updated_at = now();

do $$
declare
  v_count integer;
  v_invalid_rejected boolean := false;
  v_rls boolean;
begin
  select count(*) into v_count
    from public.marketplace_bestseller_variants
   where bestseller_id = '30000000-0000-4000-8000-000000000001'
     and source_variant_id = 'B0VARIANT01';
  if v_count <> 1 then
    raise exception 'expected one idempotently upserted canonical variant row, got %', v_count;
  end if;

  begin
    insert into public.marketplace_bestseller_variants(
      bestseller_id, marketplace, source, source_variant_id, evidence_source, fetched_at
    ) values (
      '30000000-0000-4000-8000-000000000001', 'amazon.co.jp', 'ci_fixture',
      'B0INVALID01', 'parent_product_guess', now()
    );
  exception when check_violation then
    v_invalid_rejected := true;
  end;
  if not v_invalid_rejected then
    raise exception 'unsupported/inferred evidence source was not rejected';
  end if;

  select relrowsecurity into v_rls
    from pg_class
   where oid = 'public.marketplace_bestseller_variants'::regclass;
  if v_rls is distinct from true then
    raise exception 'RLS must be enabled on canonical variant evidence';
  end if;
  if not has_table_privilege('service_role', 'public.marketplace_bestseller_variants', 'INSERT') then
    raise exception 'service_role must be able to persist canonical variant evidence';
  end if;
  if has_table_privilege('anon', 'public.marketplace_bestseller_variants', 'INSERT') then
    raise exception 'anon must not be able to insert canonical variant evidence';
  end if;
end $$;

select 'PASS: canonical marketplace variant evidence migration, idempotency, source check, and grants' as result;
