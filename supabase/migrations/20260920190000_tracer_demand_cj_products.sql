create table if not exists public.demand_cj_products (
  id uuid primary key default gen_random_uuid(),

  demand_product_candidate_id uuid not null
    references public.demand_product_candidates(id)
    on delete cascade,

  cj_product_id text not null,
  title text not null,
  sku text,
  price numeric(14,4),
  image_url text,
  inventory integer,
  listed_num integer,
  product_type text,
  sale_status text,

  cj_query text not null,
  cj_total_records integer,
  cj_total_pages integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (
    demand_product_candidate_id,
    cj_product_id
  )
);

create index if not exists demand_cj_products_candidate_idx
  on public.demand_cj_products(demand_product_candidate_id);

create index if not exists demand_cj_products_cj_product_idx
  on public.demand_cj_products(cj_product_id);

create index if not exists demand_cj_products_price_idx
  on public.demand_cj_products(price);

alter table public.demand_cj_products enable row level security;

grant all privileges on table public.demand_cj_products to service_role;
