-- TRACER unified commerce core
-- One canonical supplier-variant mapping; per-channel publication state; idempotent order intake.
create extension if not exists pgcrypto;

create table if not exists public.tc_products (
  id uuid primary key default gen_random_uuid(),
  title_ja text not null,
  description_ja text not null default '',
  image_urls text[] not null default '{}',
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tc_supplier_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.tc_products(id) on delete cascade,
  supplier_code text not null,
  supplier_product_id text not null,
  supplier_variant_id text not null,
  supplier_title text not null default '',
  source_url text,
  currency text not null default 'JPY',
  source_cost numeric(12,2) not null check (source_cost >= 0),
  shipping_cost numeric(12,2) not null default 0 check (shipping_cost >= 0),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  ship_to text not null default 'JP',
  orderable boolean not null default false,
  tracking_available boolean not null default false,
  supplier_payload jsonb not null default '{}',
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_code, supplier_product_id, supplier_variant_id)
);

create table if not exists public.tc_channel_listings (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.tc_products(id) on delete cascade,
  supplier_variant_id uuid not null references public.tc_supplier_variants(id) on delete restrict,
  channel text not null check (channel in ('base','shopify')),
  external_product_id text,
  external_variant_id text,
  external_sku text,
  selling_price numeric(12,2) not null check (selling_price > 0),
  currency text not null default 'JPY' check (currency = 'JPY'),
  published boolean not null default false,
  orderable boolean not null default false,
  sync_status text not null default 'pending' check (sync_status in ('pending','synced','blocked','error')),
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, product_id, supplier_variant_id),
  unique (channel, external_product_id, external_variant_id)
);

create table if not exists public.tc_customer_orders (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('base','shopify')),
  external_order_id text not null,
  external_order_number text,
  currency text not null default 'JPY',
  total_amount numeric(12,2) not null default 0,
  fulfillment_status text not null default 'pending' check (fulfillment_status in ('pending','supplier_ordered','shipped','fulfilled','cancelled','error')),
  payload jsonb not null default '{}',
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_order_id)
);

create table if not exists public.tc_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.tc_customer_orders(id) on delete cascade,
  channel_listing_id uuid references public.tc_channel_listings(id) on delete restrict,
  external_line_id text,
  external_sku text,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  supplier_variant_id uuid references public.tc_supplier_variants(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (order_id, external_line_id)
);

create table if not exists public.tc_supplier_orders (
  id uuid primary key default gen_random_uuid(),
  order_line_id uuid not null unique references public.tc_order_lines(id) on delete restrict,
  supplier_code text not null,
  external_supplier_order_id text,
  status text not null default 'pending' check (status in ('pending','submitted','accepted','shipped','failed','cancelled')),
  tracking_number text,
  tracking_url text,
  request_payload jsonb not null default '{}',
  response_payload jsonb not null default '{}',
  last_error text,
  submitted_at timestamptz,
  shipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tc_sync_events (
  id bigint generated always as identity primary key,
  entity_type text not null,
  entity_id text,
  channel text,
  action text not null,
  status text not null check (status in ('started','success','blocked','error')),
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists tc_supplier_variants_product_idx on public.tc_supplier_variants(product_id);
create index if not exists tc_supplier_variants_supplier_idx on public.tc_supplier_variants(supplier_code, supplier_product_id, supplier_variant_id);
create index if not exists tc_channel_listings_publish_idx on public.tc_channel_listings(channel, published, sync_status);
create index if not exists tc_orders_status_idx on public.tc_customer_orders(fulfillment_status, received_at);
create index if not exists tc_supplier_orders_status_idx on public.tc_supplier_orders(status, created_at);
create index if not exists tc_sync_events_created_idx on public.tc_sync_events(created_at desc);

alter table public.tc_products enable row level security;
alter table public.tc_supplier_variants enable row level security;
alter table public.tc_channel_listings enable row level security;
alter table public.tc_customer_orders enable row level security;
alter table public.tc_order_lines enable row level security;
alter table public.tc_supplier_orders enable row level security;
alter table public.tc_sync_events enable row level security;

comment on table public.tc_products is 'TRACER unified Japanese-language catalog; canonical product record.';
comment on table public.tc_supplier_variants is 'Canonical supplier identity and current procurement facts per supplier variant.';
comment on table public.tc_channel_listings is 'Independent BASE/Shopify listing state mapped to one canonical supplier variant.';
comment on table public.tc_customer_orders is 'Idempotent customer order intake keyed by channel and external order ID.';
comment on table public.tc_order_lines is 'Order lines resolve through channel_listing_id and supplier_variant_id, never by guessing internal IDs from SKU.';
comment on table public.tc_supplier_orders is 'One supplier procurement attempt per order line with external ACK and tracking evidence.';
