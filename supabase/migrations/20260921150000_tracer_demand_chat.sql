-- Additive Demand Intelligence + optional product views + demand/sales learning.
-- Existing demand_observations and opportunity tables are left intact.

alter table public.opportunity_intelligence
  add column if not exists demand_volume numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists demand_velocity_7d numeric(12,6);

alter table public.opportunity_intelligence
  add column if not exists demand_velocity_14d numeric(12,6);

alter table public.opportunity_intelligence
  add column if not exists demand_velocity_30d numeric(12,6);

alter table public.opportunity_intelligence
  add column if not exists demand_trend text;

alter table public.opportunity_intelligence
  add column if not exists demand_stability text;

alter table public.sales_test_results
  add column if not exists product_views integer;

create table if not exists public.demand_intelligence (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  latest_observation_id uuid references public.demand_observations(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  candidate_id uuid references public.demand_product_candidates(id) on delete set null,

  volume numeric(14,4),
  volume_unit text,
  velocity_7d numeric(12,6),
  velocity_14d numeric(12,6),
  velocity_30d numeric(12,6),
  change_7d numeric(14,4),
  change_14d numeric(14,4),
  change_30d numeric(14,4),

  trend text,
  stability text,
  spike boolean not null default false,

  demand_score numeric(8,4),
  demand_confidence numeric(5,4),
  social_mentions numeric(14,4),
  observation_count integer,
  first_observed_at timestamptz,
  last_observed_at timestamptz,

  series jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists demand_intelligence_query_key
  on public.demand_intelligence(query);

create index if not exists demand_intelligence_score_idx
  on public.demand_intelligence(demand_score desc);

create index if not exists demand_intelligence_trend_idx
  on public.demand_intelligence(trend);

create table if not exists public.demand_sales_learning (
  id uuid primary key default gen_random_uuid(),
  demand_intelligence_id uuid references public.demand_intelligence(id) on delete set null,
  opportunity_id uuid references public.opportunity_intelligence(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  test_id uuid references public.sales_tests(id) on delete set null,
  demand_query text,
  demand_score numeric(8,4),
  demand_trend text,
  forecast_units_30d numeric(14,4),
  actual_units numeric(14,4),
  impressions integer,
  clicks integer,
  product_views integer,
  add_to_cart integer,
  checkout integer,
  orders integer,
  revenue numeric(14,4),
  contribution_profit numeric(14,4),
  learning_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists demand_sales_learning_opportunity_idx
  on public.demand_sales_learning(opportunity_id, created_at desc);

alter table public.demand_intelligence enable row level security;
alter table public.demand_sales_learning enable row level security;

grant all privileges on table public.demand_intelligence to service_role;
grant all privileges on table public.demand_sales_learning to service_role;
grant all privileges on table public.opportunity_intelligence to service_role;
grant all privileges on table public.sales_test_results to service_role;
grant usage, select on all sequences in schema public to service_role;
