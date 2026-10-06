-- Shopify becomes the external sales channel while TRACER remains the
-- sourcing/procurement control plane. Additive only.

alter table public.shop_listings
  add column if not exists shopify_product_id text,
  add column if not exists shopify_variant_id text,
  add column if not exists shopify_handle text,
  add column if not exists shopify_synced_at timestamptz,
  add column if not exists shopify_sync_status text not null default 'not_synced',
  add column if not exists shopify_sync_error text;

create unique index if not exists shop_listings_shopify_product_idx
  on public.shop_listings(shopify_product_id)
  where shopify_product_id is not null;

alter table public.shop_orders
  add column if not exists shopify_order_id text,
  add column if not exists shopify_order_name text,
  add column if not exists shopify_fulfillment_status text,
  add column if not exists shopify_financial_status text,
  add column if not exists shopify_synced_at timestamptz;

create unique index if not exists shop_orders_shopify_order_idx
  on public.shop_orders(shopify_order_id)
  where shopify_order_id is not null;

create table if not exists public.shopify_webhook_events (
  id uuid primary key default gen_random_uuid(),
  shopify_event_id text not null unique,
  topic text not null,
  shopify_order_id text,
  processed boolean not null default false,
  processing_error text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists shopify_webhook_events_order_idx
  on public.shopify_webhook_events(shopify_order_id, received_at desc);

alter table public.shopify_webhook_events enable row level security;
grant all privileges on table public.shopify_webhook_events to service_role;
grant all privileges on table public.shop_listings to service_role;
grant all privileges on table public.shop_orders to service_role;
