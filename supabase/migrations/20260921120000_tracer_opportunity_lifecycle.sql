-- Additive lifecycle / evidence / experiment layer.
-- Does not replace product_intelligence.status, demand_product_candidates.status,
-- discoveries.status, or opportunity_intelligence.sellability_state.

alter table public.opportunity_intelligence
  add column if not exists lifecycle_status text not null default 'DISCOVERED';

alter table public.opportunity_intelligence
  add column if not exists demand_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists identity_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists supply_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists price_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists shipping_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists competition_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists creative_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists overall_confidence_label text;

alter table public.opportunity_intelligence
  add column if not exists observed_market_price numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists proposed_test_price numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists actual_selling_price numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists estimated_contribution_profit numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists actual_contribution_profit numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists competitor_count integer;

alter table public.opportunity_intelligence
  add column if not exists competitor_price_min numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists competitor_price_max numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists marketplace_presence boolean;

alter table public.opportunity_intelligence
  add column if not exists social_presence boolean;

alter table public.opportunity_intelligence
  add column if not exists ad_presence boolean;

alter table public.opportunity_intelligence
  add column if not exists review_count numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists review_velocity numeric(14,4);

alter table public.opportunity_intelligence
  add column if not exists evidence jsonb not null default '[]'::jsonb;

alter table public.opportunity_intelligence
  add column if not exists calculations jsonb not null default '[]'::jsonb;

alter table public.opportunity_intelligence
  add column if not exists generated_explanation jsonb not null default '{}'::jsonb;

alter table public.opportunity_intelligence
  add column if not exists data_quality jsonb not null default '{}'::jsonb;

alter table public.opportunity_intelligence
  add column if not exists first_discovered_at timestamptz;

create index if not exists opportunity_intelligence_lifecycle_idx
  on public.opportunity_intelligence(lifecycle_status);

create table if not exists public.opportunity_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity_intelligence(id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists opportunity_lifecycle_events_opportunity_idx
  on public.opportunity_lifecycle_events(opportunity_id, created_at desc);

alter table public.sales_tests
  add column if not exists creative_variant_id uuid references public.creative_variants(id) on delete set null;

alter table public.sales_tests
  add column if not exists channel text;

alter table public.sales_tests
  add column if not exists test_price numeric(14,4);

alter table public.sales_tests
  add column if not exists budget numeric(14,4);

alter table public.sales_tests
  add column if not exists start_at timestamptz;

alter table public.sales_tests
  add column if not exists end_at timestamptz;

alter table public.sales_tests
  add column if not exists hypothesis text;

alter table public.sales_tests
  add column if not exists success_criteria jsonb not null default '{}'::jsonb;

alter table public.sales_tests
  add column if not exists experiment_stage text not null default 'hypothesis';

alter table public.sales_tests
  add column if not exists maximum_loss numeric(14,4);

alter table public.sales_tests
  add column if not exists expected_test_duration text;

alter table public.sales_tests
  add column if not exists inventory_risk text;

alter table public.sales_tests
  add column if not exists shipping_risk text;

alter table public.sales_tests
  add column if not exists return_risk text;

alter table public.sales_tests
  add column if not exists compliance_risk text;

create table if not exists public.opportunity_failures (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunity_intelligence(id) on delete cascade,
  test_id uuid references public.sales_tests(id) on delete set null,
  reason_code text not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists opportunity_failures_opportunity_idx
  on public.opportunity_failures(opportunity_id);

create index if not exists opportunity_failures_reason_idx
  on public.opportunity_failures(reason_code);

create table if not exists public.intelligence_gemini_cache (
  cache_key text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.opportunity_lifecycle_events enable row level security;
alter table public.opportunity_failures enable row level security;
alter table public.intelligence_gemini_cache enable row level security;

grant all privileges on table public.opportunity_lifecycle_events to service_role;
grant all privileges on table public.opportunity_failures to service_role;
grant all privileges on table public.intelligence_gemini_cache to service_role;
grant all privileges on table public.opportunity_intelligence to service_role;
grant all privileges on table public.sales_tests to service_role;
grant usage, select on all sequences in schema public to service_role;
