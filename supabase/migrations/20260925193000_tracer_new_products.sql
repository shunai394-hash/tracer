create table if not exists public.tracer_new_products (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_url text not null,
  external_id text,
  title text not null,
  description text,
  product_url text,
  image_url text,
  category text not null,
  published_at timestamptz,
  launch_date timestamptz,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tracer_new_products_category
  on public.tracer_new_products(category);

create index if not exists idx_tracer_new_products_published_at
  on public.tracer_new_products(published_at desc);

create index if not exists idx_tracer_new_products_launch_date
  on public.tracer_new_products(launch_date);

create unique index if not exists idx_tracer_new_products_source_external
  on public.tracer_new_products(source_name, external_id)
  where external_id is not null;
