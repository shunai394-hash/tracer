-- Durable idempotency journal for Shopify color-family consolidation.
-- This table records intent and read-after-write checkpoints only; creating it
-- does not modify any Shopify or BASE catalog records.
create table if not exists public.shopify_color_family_migrations (
  id uuid primary key default gen_random_uuid(),
  supplier_code text not null,
  supplier_product_id text not null,
  canonical_product_id text not null,
  plan_hash text not null,
  expected_supplier_variant_ids text[] not null,
  shopify_product_id text,
  variant_mapping jsonb not null default '{}'::jsonb,
  status text not null default 'planned'
    check (status in ('planned', 'creating_product', 'product_created', 'creating_variants', 'variants_created', 'verified', 'blocked', 'failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_code, supplier_product_id)
);

create index if not exists idx_shopify_color_family_migrations_status_updated
  on public.shopify_color_family_migrations(status, updated_at);

create index if not exists idx_shopify_color_family_migrations_shopify_product
  on public.shopify_color_family_migrations(shopify_product_id)
  where shopify_product_id is not null;

alter table public.shopify_color_family_migrations enable row level security;
grant all privileges on public.shopify_color_family_migrations to service_role;
