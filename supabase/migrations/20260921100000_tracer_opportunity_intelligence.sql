-- Additive Opportunity Intelligence layer.
-- Existing tables and statuses are left intact.

alter table public.demand_cj_products
  add column if not exists product_id uuid references public.products(id) on delete set null;

alter table public.demand_cj_products
  add column if not exists identity_confidence numeric(5,4);

alter table public.demand_cj_products
  add column if not exists identity_status text;

alter table public.demand_cj_products
  add column if not exists identity_rationale text;

alter table public.demand_cj_products
  add column if not exists identity_metadata jsonb not null default '{}'::jsonb;

alter table public.product_offers
  add column if not exists currency_confidence text;

create index if not exists demand_cj_products_product_id_idx
  on public.demand_cj_products(product_id);

create index if not exists demand_cj_products_identity_status_idx
  on public.demand_cj_products(identity_status);

create table if not exists public.opportunity_intelligence (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,

  demand_score numeric(8,4),
  timing_score numeric(8,4),
  margin_score numeric(8,4),
  supply_score numeric(8,4),
  competition_score numeric(8,4),
  sellability_score numeric(8,4),
  creative_score numeric(8,4),
  opportunity_score numeric(8,4),

  demand_confidence numeric(5,4),
  timing_confidence numeric(5,4),
  margin_confidence numeric(5,4),
  supply_confidence numeric(5,4),
  overall_confidence numeric(5,4),

  sellability_state text not null default 'NEEDS_DATA',
  ranking_priority integer,

  why_now jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,

  market_price numeric(14,4),
  market_currency text,
  source_cost numeric(14,4),
  source_currency text,
  currency_confidence text,

  contribution_profit numeric(14,4),
  contribution_margin numeric(8,4),
  profit_calculable boolean not null default false,

  image_url text,
  product_name text,

  first_test_ready_at timestamptz,
  latest_test_status text,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists opportunity_intelligence_product_id_key
  on public.opportunity_intelligence(product_id);

create index if not exists opportunity_intelligence_state_idx
  on public.opportunity_intelligence(sellability_state);

create index if not exists opportunity_intelligence_rank_idx
  on public.opportunity_intelligence(ranking_priority);

create index if not exists opportunity_intelligence_score_idx
  on public.opportunity_intelligence(opportunity_score desc);

create table if not exists public.creative_variants (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity_intelligence(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_type text not null,
  image_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists creative_variants_opportunity_type_key
  on public.creative_variants(opportunity_id, variant_type);

create index if not exists creative_variants_product_idx
  on public.creative_variants(product_id);

create table if not exists public.sales_tests (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity_intelligence(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  status text not null default 'started',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  first_ready_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_tests_opportunity_idx
  on public.sales_tests(opportunity_id);

create index if not exists sales_tests_status_idx
  on public.sales_tests(status);

create table if not exists public.sales_test_results (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.sales_tests(id) on delete cascade,
  creative_variant_id uuid references public.creative_variants(id) on delete set null,
  measured_at timestamptz not null default now(),
  impressions integer,
  clicks integer,
  ctr numeric(12,6),
  add_to_cart integer,
  checkout integer,
  orders integer,
  cvr numeric(12,6),
  revenue numeric(14,4),
  cogs numeric(14,4),
  shipping_cost numeric(14,4),
  fees numeric(14,4),
  ad_spend numeric(14,4),
  cac numeric(14,4),
  roas numeric(12,6),
  gross_profit numeric(14,4),
  contribution_profit numeric(14,4),
  returns integer,
  refunds numeric(14,4),
  repeat_rate numeric(8,4),
  measurement_kind text not null default 'observed',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists sales_test_results_test_idx
  on public.sales_test_results(test_id);

create index if not exists sales_test_results_variant_idx
  on public.sales_test_results(creative_variant_id);

alter table public.opportunity_intelligence enable row level security;
alter table public.creative_variants enable row level security;
alter table public.sales_tests enable row level security;
alter table public.sales_test_results enable row level security;

grant all privileges on table public.opportunity_intelligence to service_role;
grant all privileges on table public.creative_variants to service_role;
grant all privileges on table public.sales_tests to service_role;
grant all privileges on table public.sales_test_results to service_role;
grant all privileges on table public.demand_cj_products to service_role;
grant all privileges on table public.product_offers to service_role;
grant usage, select on all sequences in schema public to service_role;
