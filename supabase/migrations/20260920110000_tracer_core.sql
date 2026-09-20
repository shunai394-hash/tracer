create extension if not exists pgcrypto;

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references public.brands(id) on delete set null,
  canonical_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_type text not null,
  base_url text,
  provider text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.observations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  source_id uuid references public.sources(id) on delete set null,
  source_url text,
  source_type text not null,
  observed_at timestamptz not null default now(),
  captured_at timestamptz not null default now(),
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  confidence numeric(5,4)
);

create table if not exists public.price_observations (
  id uuid primary key references public.observations(id) on delete cascade,
  currency text not null,
  amount numeric(18,4) not null
);

create table if not exists public.market_signals (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  kind text not null,
  summary text not null,
  observed_at timestamptz not null default now(),
  observation_id uuid references public.observations(id) on delete set null,
  confidence numeric(5,4)
);

create table if not exists public.discoveries (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  title text not null,
  rationale text not null,
  status text not null default 'candidate',
  created_at timestamptz not null default now(),
  observation_ids uuid[] not null default '{}'
);

create index if not exists idx_products_canonical_name
  on public.products (canonical_name);

create index if not exists idx_observations_product_id
  on public.observations (product_id);

create index if not exists idx_observations_observed_at
  on public.observations (observed_at desc);

create index if not exists idx_price_observations_currency
  on public.price_observations (currency);

create index if not exists idx_market_signals_product_id
  on public.market_signals (product_id);

create index if not exists idx_discoveries_product_id
  on public.discoveries (product_id);

alter table public.brands enable row level security;
alter table public.products enable row level security;
alter table public.sources enable row level security;
alter table public.observations enable row level security;
alter table public.price_observations enable row level security;
alter table public.market_signals enable row level security;
alter table public.discoveries enable row level security;

grant usage on schema public to service_role;

grant all privileges on table
  public.brands,
  public.products,
  public.sources,
  public.observations,
  public.price_observations,
  public.market_signals,
  public.discoveries
to service_role;

grant usage, select on all sequences in schema public
to service_role;
