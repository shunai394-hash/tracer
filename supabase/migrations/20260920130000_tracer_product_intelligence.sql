create table if not exists public.product_intelligence (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,

  normalized_title text not null,
  brand_name text,
  category text,

  seller_name text,
  source_url text,
  image_url text,

  currency text,
  current_price numeric(12,2),

  price_confidence numeric(5,4),
  identity_confidence numeric(5,4),

  demand_signal numeric(8,4),
  supply_signal numeric(8,4),
  trend_signal numeric(8,4),
  opportunity_score numeric(8,4),

  status text not null default 'candidate'
    check (status in ('candidate', 'review', 'accepted', 'rejected')),

  metadata jsonb not null default '{}'::jsonb,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists product_intelligence_product_id_key
  on public.product_intelligence(product_id);

create index if not exists product_intelligence_status_idx
  on public.product_intelligence(status);

create index if not exists product_intelligence_opportunity_score_idx
  on public.product_intelligence(opportunity_score desc);

alter table public.product_intelligence enable row level security;

grant all privileges on table public.product_intelligence to service_role;
grant usage, select on all sequences in schema public to service_role;
