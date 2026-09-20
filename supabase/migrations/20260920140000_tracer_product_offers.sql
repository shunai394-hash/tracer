create table if not exists public.product_offers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,

  seller_name text,
  offer_url text,
  image_url text,

  currency text,
  price numeric(12,2),

  availability text,
  shipping_price numeric(12,2),

  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists product_offers_product_id_idx
  on public.product_offers(product_id);

create index if not exists product_offers_observed_at_idx
  on public.product_offers(observed_at desc);

create index if not exists product_offers_price_idx
  on public.product_offers(price);

alter table public.product_offers enable row level security;

grant all privileges on table public.product_offers to service_role;
grant usage, select on all sequences in schema public to service_role;
