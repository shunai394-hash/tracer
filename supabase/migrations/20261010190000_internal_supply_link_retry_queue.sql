create table if not exists public.internal_supply_link_retry_queue (
  bestseller_id text primary key,
  supplier_listing_id text null,
  supply_variant_id text null,
  reason text not null,
  link_status text null,
  retry_count integer not null default 0 check (retry_count >= 0),
  last_attempt_at timestamptz null,
  next_attempt_at timestamptz not null default now(),
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists internal_supply_link_retry_queue_due_idx
  on public.internal_supply_link_retry_queue (next_attempt_at asc);

alter table public.internal_supply_link_retry_queue enable row level security;

comment on table public.internal_supply_link_retry_queue is
  'Durable, reason-coded retries for internal marketplace-to-supplier identity linking. Service-role only; not a signal that a product is sellable.';
