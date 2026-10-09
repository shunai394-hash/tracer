-- Durable per-candidate audit trail for CJ -> internal supply ingestion.
-- Ordered after 20261010143000_tracer_internal_supply_conflict_targets.sql.
-- Keep this schema compatible with 20261009180000_tracer_internal_supply_atomic_audit.sql.
-- The ALTERs also repair environments where the earlier migration was recorded but
-- the table was later removed or created incompletely.
create table if not exists public.internal_supply_ingestion_audit (
  id bigserial primary key,
  request_id uuid not null,
  item_index integer not null,
  source_name text,
  source_ref text,
  bestseller_id uuid,
  outcome text not null check (outcome in ('started','rejected','draft_ingested','sync_blocked','synced','failed')),
  product_id uuid,
  submitted_variant_count integer not null default 0 check (submitted_variant_count >= 0),
  written_variant_ids uuid[] not null default '{}'::uuid[],
  catalog_id uuid,
  error_codes text[] not null default '{}'::text[],
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Ensure the audit contract required by both ingestion paths exists even if an
-- earlier table definition is already present. IF NOT EXISTS is safe on either schema.
alter table public.internal_supply_ingestion_audit
  add column if not exists bestseller_id uuid,
  add column if not exists product_id uuid,
  add column if not exists submitted_variant_count integer not null default 0,
  add column if not exists written_variant_ids uuid[] not null default '{}'::uuid[],
  add column if not exists catalog_id uuid,
  add column if not exists error_codes text[] not null default '{}'::text[],
  add column if not exists details jsonb not null default '{}'::jsonb;

create index if not exists internal_supply_ingestion_audit_source_ref_idx
  on public.internal_supply_ingestion_audit(source_name, source_ref, created_at desc);
create index if not exists internal_supply_ingestion_audit_request_idx
  on public.internal_supply_ingestion_audit(request_id, item_index);
create unique index if not exists internal_supply_ingestion_audit_request_item_uq
  on public.internal_supply_ingestion_audit(request_id, item_index);

alter table public.internal_supply_ingestion_audit enable row level security;
revoke all on public.internal_supply_ingestion_audit from anon, authenticated;
grant all on public.internal_supply_ingestion_audit to service_role;
