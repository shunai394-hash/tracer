\set ON_ERROR_STOP on

-- Disposable CI database only; minimal existing table fixtures.
create table public.marketplace_bestsellers (
  id uuid primary key,
  marketplace text not null,
  title text not null,
  source text not null
);

create table public.internal_supply_links (
  id uuid primary key default gen_random_uuid(),
  bestseller_id uuid not null,
  supply_product_id uuid not null,
  supply_variant_id uuid not null,
  identity_method text not null,
  identity_confidence numeric not null,
  identity_rationale text not null,
  status text not null
);

\i supabase/migrations/20261010170000_marketplace_bestseller_variants.sql
\i supabase/migrations/20261010180000_internal_supply_canonical_variant_links.sql
\i supabase/migrations/20261010180000_internal_supply_canonical_variant_links.sql

insert into public.marketplace_bestsellers(id, marketplace, title, source)
values ('30000000-0000-4000-8000-000000000001', 'amazon.co.jp', 'Parent product', 'ci_fixture');

insert into public.marketplace_bestseller_variants(
  id, bestseller_id, marketplace, source, source_variant_id, jan, evidence_source, fetched_at
) values (
  '40000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'amazon.co.jp', 'ci_fixture', 'CHILD-VARIANT-1', '4006381333931',
  'schema_org_product_group_has_variant', now()
);

insert into public.internal_supply_links(
  id, bestseller_id, supply_product_id, supply_variant_id,
  marketplace_variant_evidence_id, identity_method, identity_confidence,
  identity_rationale, status
) values (
  '50000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  'jan', 0.98, 'exact child-variant JAN match', 'verified'
);

do $$
declare
  v_evidence_id uuid;
  v_fk_exists boolean;
begin
  select marketplace_variant_evidence_id into v_evidence_id
    from public.internal_supply_links
   where id = '50000000-0000-4000-8000-000000000001';
  if v_evidence_id <> '40000000-0000-4000-8000-000000000001' then
    raise exception 'canonical child evidence ID was not persisted';
  end if;

  select exists (
    select 1
      from pg_constraint
     where conrelid = 'public.internal_supply_links'::regclass
       and contype = 'f'
       and confrelid = 'public.marketplace_bestseller_variants'::regclass
  ) into v_fk_exists;
  if not v_fk_exists then
    raise exception 'supplier link must have a foreign key to canonical child evidence';
  end if;

  begin
    update public.internal_supply_links
       set marketplace_variant_evidence_id = '40000000-0000-4000-8000-000000000099'
     where id = '50000000-0000-4000-8000-000000000001';
    raise exception 'nonexistent child evidence ID was accepted';
  exception when foreign_key_violation then
    null;
  end;
end $$;

select 'PASS: supplier link stores a foreign-keyed canonical child-variant evidence ID' as result;
