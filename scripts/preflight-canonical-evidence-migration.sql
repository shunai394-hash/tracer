-- Read-only preflight for the canonical marketplace evidence migration.
-- Run against the intended Supabase project before applying pending migrations.
-- This file deliberately performs no DDL or data writes.
do $$
declare
  constraint_definition text;
  migration_ledger regclass := to_regclass('supabase_migrations.schema_migrations');
begin
  if to_regclass('public.marketplace_bestseller_variants') is null then
    raise exception 'PRECHECK FAILED: public.marketplace_bestseller_variants does not exist';
  end if;

  select pg_get_constraintdef(c.oid)
    into constraint_definition
    from pg_constraint c
   where c.conrelid = 'public.marketplace_bestseller_variants'::regclass
     and c.conname = 'marketplace_bestseller_variants_evidence_source_check'
     and c.contype = 'c';

  if constraint_definition is null then
    raise exception 'PRECHECK FAILED: expected evidence_source check constraint is missing; reconcile schema before migration';
  end if;

  if position('schema_org_product_group_has_variant' in constraint_definition) = 0 then
    raise exception 'PRECHECK FAILED: live evidence_source constraint is unexpected: %', constraint_definition;
  end if;

  if migration_ledger is null then
    raise exception 'PRECHECK FAILED: Supabase migration ledger is unavailable; verify project and migration history';
  end if;
end $$;

select
  current_database() as database_name,
  c.conname as constraint_name,
  pg_get_constraintdef(c.oid) as live_constraint_definition
from pg_constraint c
where c.conrelid = 'public.marketplace_bestseller_variants'::regclass
  and c.conname = 'marketplace_bestseller_variants_evidence_source_check';

-- Show applied/pending status without changing the ledger.
select
  expected.version,
  (applied.version is not null) as is_applied
from (values
  ('20261010170000'),
  ('20261011110000'),
  ('20261011160000')
) as expected(version)
left join supabase_migrations.schema_migrations applied
  on applied.version::text = expected.version
order by expected.version;

select
  'PRECHECK PASS: expected table, recognizable live constraint, and readable migration ledger; review versions above before applying' as result;
