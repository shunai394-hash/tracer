-- Persisted evidence for live BASE and Shopify price/SKU/publication audits.
-- The reconciliation route inserted into this table before the table existed,
-- so every batch failed and the audit saved zero rows.
create table if not exists public.channel_price_reconciliation_audit (
  id bigint generated always as identity primary key,
  run_id text not null,
  channel text not null check (channel in ('base', 'shopify')),
  external_product_id text,
  external_variant_id text,
  variant_id uuid,
  external_sku text,
  internal_sku text,
  product_title text,
  external_price numeric(14, 2),
  canonical_price numeric(14, 2),
  db_channel_price numeric(14, 2),
  product_status text,
  price_matches boolean,
  sku_matches boolean,
  observed_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.channel_price_reconciliation_audit
  add column if not exists run_id text,
  add column if not exists channel text,
  add column if not exists external_product_id text,
  add column if not exists external_variant_id text,
  add column if not exists variant_id uuid,
  add column if not exists external_sku text,
  add column if not exists internal_sku text,
  add column if not exists product_title text,
  add column if not exists external_price numeric(14, 2),
  add column if not exists canonical_price numeric(14, 2),
  add column if not exists db_channel_price numeric(14, 2),
  add column if not exists product_status text,
  add column if not exists price_matches boolean,
  add column if not exists sku_matches boolean,
  add column if not exists observed_at timestamptz default now(),
  add column if not exists details jsonb default '{}'::jsonb,
  add column if not exists created_at timestamptz default now();

create index if not exists idx_channel_price_reconciliation_audit_run
  on public.channel_price_reconciliation_audit (run_id, channel, external_product_id);

create unique index if not exists uq_channel_price_reconciliation_audit_item
  on public.channel_price_reconciliation_audit (run_id, channel, external_product_id)
  where external_product_id is not null;

alter table public.channel_price_reconciliation_audit enable row level security;
grant all privileges on public.channel_price_reconciliation_audit to service_role;
grant usage, select on all sequences in schema public to service_role;

notify pgrst, 'reload schema';
