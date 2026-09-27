-- Persistent stage/status/reason telemetry for the market-to-publication funnel.
-- This is additive: historical rows remain queryable and existing publication
-- behavior is not changed by the migration itself.

alter table public.marketplace_bestsellers
  add column if not exists pipeline_stage text not null default 'DISCOVERED',
  add column if not exists pipeline_status text not null default 'pending',
  add column if not exists pipeline_reason text,
  add column if not exists pipeline_error text,
  add column if not exists pipeline_updated_at timestamptz not null default now();

create index if not exists marketplace_bestsellers_pipeline_idx
  on public.marketplace_bestsellers(pipeline_stage, pipeline_status, pipeline_updated_at desc);

alter table public.shop_listings
  add column if not exists pipeline_stage text not null default 'PUBLISHED',
  add column if not exists pipeline_status text not null default 'published',
  add column if not exists pipeline_reason text,
  add column if not exists pipeline_error text,
  add column if not exists pipeline_updated_at timestamptz not null default now();

create index if not exists shop_listings_pipeline_idx
  on public.shop_listings(pipeline_stage, pipeline_status, pipeline_updated_at desc);

grant all privileges on table public.marketplace_bestsellers to service_role;
grant all privileges on table public.shop_listings to service_role;
