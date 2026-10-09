-- Atomic idempotency for internal supply ingestion and durable audit evidence.
-- NULL source_ref values remain allowed; the API requires non-empty source_ref.
create unique index if not exists internal_supply_products_source_name_ref_atomic_uq
  on public.internal_supply_products(source_name, source_ref);

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
  written_variant_ids uuid[] not null default '{}',
  catalog_id uuid,
  error_codes text[] not null default '{}',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists internal_supply_ingestion_audit_request_idx
  on public.internal_supply_ingestion_audit(request_id, item_index);

create index if not exists internal_supply_ingestion_audit_source_idx
  on public.internal_supply_ingestion_audit(source_name, source_ref, created_at desc);

alter table public.internal_supply_ingestion_audit enable row level security;

create unique index if not exists internal_supply_ingestion_audit_request_item_uq
  on public.internal_supply_ingestion_audit(request_id, item_index);
