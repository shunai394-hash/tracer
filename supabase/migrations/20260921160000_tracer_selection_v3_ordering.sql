-- Additive selection v3 + ordering layer. Existing tables stay intact.

alter table public.opportunity_intelligence
  add column if not exists ranking_velocity numeric(12,6);

alter table public.opportunity_intelligence
  add column if not exists ranking_velocity_confidence numeric(5,4);

alter table public.opportunity_intelligence
  add column if not exists seller_count integer;

alter table public.opportunity_intelligence
  add column if not exists seller_velocity numeric(12,6);

alter table public.opportunity_intelligence
  add column if not exists price_median numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists roi numeric(12,6);

alter table public.opportunity_intelligence
  add column if not exists total_cost numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists stockout_rate numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists supply_gap boolean;

alter table public.opportunity_intelligence
  add column if not exists account_fit_score numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists account_fit_confidence numeric(5,4);

alter table public.opportunity_intelligence
  add column if not exists profit_state text;

alter table public.opportunity_intelligence
  add column if not exists filter_state text;

alter table public.opportunity_intelligence
  add column if not exists forecast_units_90d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_revenue_90d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_profit_90d numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists supply_score_v3 numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists competition_score_v3 numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists profit_score_v3 numeric(8,4);

alter table public.opportunity_intelligence
  add column if not exists forecast_score_v3 numeric(8,4);

create table if not exists public.selection_settings (
  id text primary key default 'default',
  min_margin_pct numeric(8,4),
  min_forecast_units_30d numeric(14,4),
  max_seller_count integer,
  min_forecast_profit numeric(14,4),
  max_weight_kg numeric(12,4),
  allowed_categories jsonb not null default '[]'::jsonb,
  excluded_categories jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.selection_settings (id)
values ('default')
on conflict (id) do nothing;

create table if not exists public.ordering_settings (
  id text primary key default 'default',
  mode text not null default 'APPROVAL',
  daily_order_limit numeric(14,4),
  per_product_order_limit numeric(14,4),
  monthly_order_budget numeric(14,4),
  category_budgets jsonb not null default '{}'::jsonb,
  default_lead_time_days integer,
  default_safety_stock integer,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  check (mode in ('MANUAL', 'APPROVAL', 'AUTO'))
);

insert into public.ordering_settings (id, mode)
values ('default', 'APPROVAL')
on conflict (id) do nothing;

create table if not exists public.inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  opportunity_id uuid references public.opportunity_intelligence(id) on delete set null,
  kind text not null,
  on_hand integer,
  inbound integer,
  observed_at timestamptz not null default now(),
  source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists inventory_snapshots_product_idx
  on public.inventory_snapshots(product_id, observed_at desc);

create table if not exists public.inventory_forecasts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  opportunity_id uuid references public.opportunity_intelligence(id) on delete set null,
  horizon_days integer not null,
  on_hand integer,
  inbound integer,
  forecast_units numeric(14,4),
  projected_on_hand numeric(14,4),
  confidence numeric(5,4),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists inventory_forecasts_product_idx
  on public.inventory_forecasts(product_id, created_at desc);

create table if not exists public.reorder_recommendations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  opportunity_id uuid references public.opportunity_intelligence(id) on delete set null,
  on_hand integer,
  inbound integer,
  forecast_units_30d numeric(14,4),
  average_daily_sales numeric(14,4),
  lead_time_days integer,
  safety_stock integer,
  reorder_point numeric(14,4),
  recommended_qty numeric(14,4),
  recommended_date date,
  estimated_cost numeric(14,4),
  estimated_profit numeric(14,4),
  currency text,
  confidence numeric(5,4),
  order_state text not null,
  rationale text,
  missing jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reorder_recommendations_product_idx
  on public.reorder_recommendations(product_id, created_at desc);

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  opportunity_id uuid references public.opportunity_intelligence(id) on delete set null,
  recommendation_id uuid references public.reorder_recommendations(id) on delete set null,
  supplier_name text,
  qty numeric(14,4) not null,
  unit_cost numeric(14,4),
  shipping_cost numeric(14,4),
  total_cost numeric(14,4),
  currency text,
  forecast_units numeric(14,4),
  forecast_profit numeric(14,4),
  forecast_confidence numeric(5,4),
  rationale text,
  status text not null default 'draft',
  mode text not null,
  approved_by text,
  supplier_order_id text,
  placed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists purchase_orders_product_idx
  on public.purchase_orders(product_id, created_at desc);

create table if not exists public.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  qty numeric(14,4) not null,
  unit_cost numeric(14,4),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.supplier_performance (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null,
  product_id uuid references public.products(id) on delete set null,
  on_hand integer,
  lead_time_days integer,
  delay_days integer,
  price_change numeric(12,6),
  discontinued boolean,
  risk_note text,
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists supplier_performance_supplier_idx
  on public.supplier_performance(supplier_name, observed_at desc);

alter table public.selection_settings enable row level security;
alter table public.ordering_settings enable row level security;
alter table public.inventory_snapshots enable row level security;
alter table public.inventory_forecasts enable row level security;
alter table public.reorder_recommendations enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_items enable row level security;
alter table public.supplier_performance enable row level security;

grant all privileges on table public.selection_settings to service_role;
grant all privileges on table public.ordering_settings to service_role;
grant all privileges on table public.inventory_snapshots to service_role;
grant all privileges on table public.inventory_forecasts to service_role;
grant all privileges on table public.reorder_recommendations to service_role;
grant all privileges on table public.purchase_orders to service_role;
grant all privileges on table public.purchase_order_items to service_role;
grant all privileges on table public.supplier_performance to service_role;
grant all privileges on table public.opportunity_intelligence to service_role;
grant usage, select on all sequences in schema public to service_role;
