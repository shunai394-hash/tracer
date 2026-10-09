-- Durable per-candidate audit trail for CJ -> internal supply ingestion.
-- Ordered after 20261010143000_tracer_internal_supply_conflict_targets.sql.
create table if not exists public.internal_supply_ingestion_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  item_index integer not null default 0,
  source_name text not null,
  source_ref text,
  outcome text not null,
  product_id uuid references public.internal_supply_products(id) on delete set null,
  submitted_variant_count integer not null default 0,
  written_variant_ids uuid[] not null default '{}'::uuid[],
  error_codes text[] not null default '{}'::text[],
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists internal_supply_ingestion_audit_source_ref_idx
  on public.internal_supply_ingestion_audit(source_name, source_ref, created_at desc);
create index if not exists internal_supply_ingestion_audit_request_idx
  on public.internal_supply_ingestion_audit(request_id, item_index);

alter table public.internal_supply_ingestion_audit enable row level security;
revoke all on public.internal_supply_ingestion_audit from anon, authenticated;
grant all on public.internal_supply_ingestion_audit to service_role;
