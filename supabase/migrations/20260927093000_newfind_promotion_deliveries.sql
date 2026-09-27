create table if not exists public.newfind_promotion_deliveries (
  listing_id uuid primary key references public.shop_listings(id) on delete cascade,
  event_id text not null unique,
  status text not null default 'pending'
    check (status in ('pending','sent','processed','failed')),
  http_status integer,
  ack_status text,
  attempts integer not null default 0,
  last_error text,
  last_attempt_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists newfind_promotion_deliveries_status_idx
  on public.newfind_promotion_deliveries(status, updated_at);

grant all privileges on table public.newfind_promotion_deliveries to service_role;
