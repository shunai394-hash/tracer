create table if not exists public.demand_product_matches (
  id uuid primary key default gen_random_uuid(),

  demand_observation_id uuid not null
    references public.demand_observations(id)
    on delete cascade,

  product_id uuid not null
    references public.products(id)
    on delete cascade,

  match_method text not null
    check (match_method in (
      'keyword',
      'category',
      'brand',
      'semantic',
      'manual'
    )),

  match_score numeric(8,4),

  rationale text,

  created_at timestamptz not null default now()
);

create unique index if not exists
  demand_product_matches_unique_key
  on public.demand_product_matches(
    demand_observation_id,
    product_id
  );

create index if not exists
  demand_product_matches_demand_idx
  on public.demand_product_matches(demand_observation_id);

create index if not exists
  demand_product_matches_product_idx
  on public.demand_product_matches(product_id);

create index if not exists
  demand_product_matches_score_idx
  on public.demand_product_matches(match_score desc);

alter table public.demand_product_matches enable row level security;

grant all privileges on table public.demand_product_matches
to service_role;

grant usage, select on all sequences in schema public
to service_role;
