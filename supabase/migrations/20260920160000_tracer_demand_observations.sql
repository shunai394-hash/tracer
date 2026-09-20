create table if not exists public.demand_observations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,

  source_id uuid references public.sources(id) on delete set null,

  signal_type text not null
    check (signal_type in (
      'search_volume',
      'search_growth',
      'social_mentions',
      'review_velocity',
      'sales_rank',
      'other'
    )),

  value numeric(14,4),
  unit text,

  observed_at timestamptz not null default now(),

  metadata jsonb not null default '{}'::jsonb
);

create index if not exists demand_observations_product_id_idx
  on public.demand_observations(product_id);

create index if not exists demand_observations_observed_at_idx
  on public.demand_observations(observed_at desc);

create index if not exists demand_observations_signal_type_idx
  on public.demand_observations(signal_type);

alter table public.demand_observations enable row level security;

grant all privileges on table public.demand_observations to service_role;
grant usage, select on all sequences in schema public
to service_role;
