-- Additive product selection, sales forecast, and search-fit layer.
-- Existing tables, statuses, and rows are left intact.

alter table public.opportunity_intelligence
  add column if not exists selection_score numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists selection_eligible boolean;

alter table public.opportunity_intelligence
  add column if not exists identity_score numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists market_gap_score numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists market_gap_confidence numeric(5,4);

alter table public.opportunity_intelligence
  add column if not exists search_fit_score numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists search_fit_confidence numeric(5,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_units_7d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_units_30d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_units_7d_low numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_units_7d_high numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_units_30d_low numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_units_30d_high numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_revenue_7d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_revenue_30d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_profit_7d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_profit_30d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_margin numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_confidence numeric(5,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_kind text;

alter table public.opportunity_intelligence
  add column if not exists forecast_model_id text;

alter table public.opportunity_intelligence
  add column if not exists forecast_error_units_30d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists recommendation_summary text;

alter table public.opportunity_intelligence
  add column if not exists recommendation_reasons jsonb not null default '[]'::jsonb;

create index if not exists opportunity_intelligence_selection_idx
  on public.opportunity_intelligence(selection_eligible, selection_score desc);

create table if not exists public.product_sales_forecasts (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity_intelligence(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  model_id text not null,
  horizon_days integer not null,
  units numeric(14,4),
  units_low numeric(14,4),
  units_high numeric(14,4),
  revenue numeric(14,4),
  contribution_profit numeric(14,4),
  contribution_margin numeric(8,4),
  confidence numeric(5,4),
  kind text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists product_sales_forecasts_opportunity_idx
  on public.product_sales_forecasts(opportunity_id, created_at desc);

create index if not exists product_sales_forecasts_product_idx
  on public.product_sales_forecasts(product_id, created_at desc);

create table if not exists public.product_forecast_errors (
  id uuid primary key default gen_random_uuid(),
  forecast_id uuid references public.product_sales_forecasts(id) on delete set null,
  opportunity_id uuid not null references public.opportunity_intelligence(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  test_id uuid references public.sales_tests(id) on delete set null,
  horizon_days integer not null,
  predicted_units numeric(14,4),
  actual_units numeric(14,4),
  error_units numeric(14,4),
  predicted_revenue numeric(14,4),
  actual_revenue numeric(14,4),
  error_revenue numeric(14,4),
  predicted_profit numeric(14,4),
  actual_profit numeric(14,4),
  error_profit numeric(14,4),
  measurement_kind text not null default 'observed',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists product_forecast_errors_opportunity_idx
  on public.product_forecast_errors(opportunity_id, created_at desc);

create index if not exists product_forecast_errors_product_idx
  on public.product_forecast_errors(product_id, created_at desc);

alter table public.product_sales_forecasts enable row level security;
alter table public.product_forecast_errors enable row level security;

grant all privileges on table public.product_sales_forecasts to service_role;
grant all privileges on table public.product_forecast_errors to service_role;
grant all privileges on table public.opportunity_intelligence to service_role;
grant usage, select on all sequences in schema public to service_role;
