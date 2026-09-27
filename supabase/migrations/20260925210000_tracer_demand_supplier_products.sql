create table if not exists public.demand_supplier_products (
  id uuid primary key default gen_random_uuid(),

  demand_product_candidate_id uuid not null
    references public.demand_product_candidates(id)
    on delete cascade,

  supplier_name text not null,
  supplier_product_id text not null,
  title text not null,
  sku text,
  identifier text,
  price numeric(14,4),
  currency text,
  image_url text,
  source_url text,
  inventory integer,
  available boolean,
  orderable boolean,
  tracking_available boolean,
  supplier_query text not null,
  total_records integer,
  total_pages integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (
    demand_product_candidate_id,
    supplier_name,
    supplier_product_id
  )
);

create index if not exists demand_supplier_products_candidate_idx
  on public.demand_supplier_products(demand_product_candidate_id);

create index if not exists demand_supplier_products_supplier_idx
  on public.demand_supplier_products(supplier_name);

create index if not exists demand_supplier_products_product_idx
  on public.demand_supplier_products(supplier_product_id);

create index if not exists demand_supplier_products_identifier_idx
  on public.demand_supplier_products(identifier);

create index if not exists demand_supplier_products_price_idx
  on public.demand_supplier_products(price);

alter table public.demand_supplier_products enable row level security;

grant all privileges on table public.demand_supplier_products to service_role;
