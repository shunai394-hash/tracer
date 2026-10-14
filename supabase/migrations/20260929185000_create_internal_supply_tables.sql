-- The internal supply tables are referenced by later migrations and by the
-- ingestion route, but no earlier migration in this repository creates them.
-- Git history has no CREATE TABLE for these relations either. This file is
-- ordered before 20260929190000 so a fresh database can apply the index,
-- foreign-key, and rowtype migrations that follow.
--
-- Existing databases that already have these tables are left unchanged:
-- CREATE TABLE IF NOT EXISTS does not add, drop, or retype columns.
-- generation is intentionally absent here; 20261010100000 adds it.

create table if not exists public.internal_supply_products (
  id uuid primary key default gen_random_uuid(),
  product_id text,
  sku text,
  title text not null,
  brand text,
  jan text,
  gtin text,
  ean text,
  upc text,
  mpn text,
  cost numeric,
  shipping_cost numeric,
  currency text,
  inventory integer not null default 0,
  lead_time_days integer,
  ship_to text,
  tracking_available boolean not null default false,
  order_method text,
  api_available boolean not null default false,
  active boolean not null default false,
  source_name text not null,
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  fetched_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.internal_supply_variants (
  id uuid primary key default gen_random_uuid(),
  supply_product_id uuid not null references public.internal_supply_products(id) on delete restrict,
  variant_sku text,
  variant_id text,
  title text,
  jan text,
  gtin text,
  ean text,
  upc text,
  cost numeric,
  shipping_cost numeric,
  currency text,
  inventory integer not null default 0,
  orderable boolean not null default false,
  tracking_available boolean not null default false,
  active boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  fetched_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 20260930050000 indexes this relation, then 20261004020000 drops that
-- duplicate index. The primary key remains the canonical uniqueness rule
-- used by the application's 23505 read-back.
create table if not exists public.internal_supply_links (
  bestseller_id uuid not null references public.marketplace_bestsellers(id) on delete restrict,
  supply_product_id uuid not null references public.internal_supply_products(id) on delete restrict,
  supply_variant_id uuid not null references public.internal_supply_variants(id) on delete restrict,
  identity_method text,
  identity_confidence numeric,
  identity_rationale text,
  status text not null,
  primary key (bestseller_id, supply_product_id, supply_variant_id)
);

alter table public.internal_supply_products enable row level security;
alter table public.internal_supply_variants enable row level security;
alter table public.internal_supply_links enable row level security;

revoke all on table public.internal_supply_products from anon, authenticated;
revoke all on table public.internal_supply_variants from anon, authenticated;
revoke all on table public.internal_supply_links from anon, authenticated;

grant all on table public.internal_supply_products to service_role;
grant all on table public.internal_supply_variants to service_role;
grant all on table public.internal_supply_links to service_role;
