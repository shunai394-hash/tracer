create table if not exists public.demand_product_candidates (
  id uuid primary key default gen_random_uuid(),

  demand_observation_id uuid not null
    references public.demand_observations(id)
    on delete cascade,

  query text not null,

  category text,

  status text not null default 'new'
    check (status in (
      'new',
      'researching',
      'product_found',
      'offer_found',
      'opportunity',
      'rejected'
    )),

  source text,

  rationale text,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()
);

create unique index if not exists
  demand_product_candidates_demand_unique_key
  on public.demand_product_candidates(demand_observation_id);

create index if not exists
  demand_product_candidates_status_idx
  on public.demand_product_candidates(status);

create index if not exists
  demand_product_candidates_category_idx
  on public.demand_product_candidates(category);

create index if not exists
  demand_product_candidates_query_idx
  on public.demand_product_candidates(query);

alter table public.demand_product_candidates enable row level security;

grant all privileges on table public.demand_product_candidates
to service_role;

grant usage, select on all sequences in schema public
to service_role;
