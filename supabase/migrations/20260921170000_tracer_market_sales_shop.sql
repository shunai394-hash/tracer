-- Bestsellers-first discovery, evidence ledger, identifiers, suppliers, shop.
-- Additive only. Existing tables stay intact.

alter table public.products
  add column if not exists asin text;

alter table public.products
  add column if not exists jan text;

alter table public.products
  add column if not exists gtin text;

alter table public.products
  add column if not exists ean text;

alter table public.products
  add column if not exists upc text;

alter table public.products
  add column if not exists mpn text;

create table if not exists public.marketplace_bestsellers (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  rank integer,
  category text,
  title text not null,
  brand text,
  model text,
  asin text,
  jan text,
  gtin text,
  ean text,
  upc text,
  mpn text,
  price numeric(14,4),
  currency text,
  review_count integer,
  product_url text,
  image_url text,
  fetched_at timestamptz not null default now(),
  source text not null,
  source_url text,
  product_id uuid references public.products(id) on delete set null,
  raw jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists marketplace_bestsellers_market_idx
  on public.marketplace_bestsellers(marketplace, fetched_at desc);

create index if not exists marketplace_bestsellers_asin_idx
  on public.marketplace_bestsellers(asin)
  where asin is not null;

create table if not exists public.evidence_ledger (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  bestseller_id uuid references public.marketplace_bestsellers(id) on delete set null,
  supplier_listing_id uuid,
  source text not null,
  url text,
  fetched_at timestamptz not null default now(),
  field_name text not null,
  field_value text,
  evidence_class text not null,
  confidence numeric(5,4),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (evidence_class in ('actual', 'estimated', 'unknown'))
);

create index if not exists evidence_ledger_product_idx
  on public.evidence_ledger(product_id, fetched_at desc);

create table if not exists public.product_identifiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete cascade,
  bestseller_id uuid references public.marketplace_bestsellers(id) on delete set null,
  scheme text not null,
  value text not null,
  source text not null,
  fetched_at timestamptz not null default now(),
  unique (scheme, value)
);

create table if not exists public.supplier_listings (
  id uuid primary key default gen_random_uuid(),
  supplier text not null,
  external_id text,
  sku text,
  title text,
  bestseller_id uuid references public.marketplace_bestsellers(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  asin text,
  jan text,
  gtin text,
  ean text,
  upc text,
  mpn text,
  cost numeric(14,4),
  shipping_cost numeric(14,4),
  currency text,
  inventory integer,
  lead_time_days integer,
  ship_to text,
  tracking_available boolean,
  return_policy text,
  order_method text,
  api_available boolean,
  identity_method text,
  identity_status text,
  identity_confidence numeric(5,4),
  configured boolean not null default false,
  fetched_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists supplier_listings_bestseller_idx
  on public.supplier_listings(bestseller_id, created_at desc);

create table if not exists public.shop_listings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  bestseller_id uuid references public.marketplace_bestsellers(id) on delete set null,
  opportunity_id uuid references public.opportunity_intelligence(id) on delete set null,
  sales_test_id uuid,
  supplier_listing_id uuid references public.supplier_listings(id) on delete set null,
  slug text not null unique,
  title text not null,
  description text,
  image_url text,
  selling_price numeric(14,4),
  currency text,
  published boolean not null default false,
  selection_reasons jsonb not null default '[]'::jsonb,
  missing jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.shop_listings(id) on delete set null,
  sales_test_id uuid,
  status text not null default 'placed',
  payment_method text not null,
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  shipping_address text not null,
  subtotal numeric(14,4),
  shipping_cost numeric(14,4),
  total numeric(14,4),
  currency text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.shop_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.shop_orders(id) on delete cascade,
  listing_id uuid references public.shop_listings(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  title text not null,
  qty numeric(14,4) not null,
  unit_price numeric(14,4),
  currency text
);

create table if not exists public.shop_funnel_events (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.shop_listings(id) on delete cascade,
  event_type text not null,
  qty integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (event_type in ('impression', 'click', 'view', 'add_to_cart', 'checkout', 'purchase'))
);

alter table public.marketplace_bestsellers enable row level security;
alter table public.evidence_ledger enable row level security;
alter table public.product_identifiers enable row level security;
alter table public.supplier_listings enable row level security;
alter table public.shop_listings enable row level security;
alter table public.shop_orders enable row level security;
alter table public.shop_order_items enable row level security;
alter table public.shop_funnel_events enable row level security;

grant all privileges on table public.marketplace_bestsellers to service_role;
grant all privileges on table public.evidence_ledger to service_role;
grant all privileges on table public.product_identifiers to service_role;
grant all privileges on table public.supplier_listings to service_role;
grant all privileges on table public.shop_listings to service_role;
grant all privileges on table public.shop_orders to service_role;
grant all privileges on table public.shop_order_items to service_role;
grant all privileges on table public.shop_funnel_events to service_role;
grant all privileges on table public.products to service_role;
grant usage, select on all sequences in schema public to service_role;
