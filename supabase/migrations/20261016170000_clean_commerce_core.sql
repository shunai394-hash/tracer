-- Clean commerce core v1. The legacy tables remain empty and are not used by the new flow.
create extension if not exists pgcrypto;
create table if not exists public.commerce_products (
 id uuid primary key default gen_random_uuid(), source_key text not null unique,
 title_ja text not null, description_ja text not null default '', brand text, category text,
 image_url text, source_url text, metadata jsonb not null default '{}'::jsonb,
 active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.commerce_variants (
 id uuid primary key default gen_random_uuid(), product_id uuid not null references public.commerce_products(id) on delete cascade,
 source_variant_key text not null, title_ja text not null default '標準', sku text, attributes jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(product_id, source_variant_key)
);
create table if not exists public.supplier_offers (
 id uuid primary key default gen_random_uuid(), variant_id uuid not null references public.commerce_variants(id) on delete cascade,
 supplier_code text not null, supplier_product_id text not null, supplier_variant_id text not null, supplier_url text,
 currency text not null default 'USD', unit_cost numeric(14,2) not null check(unit_cost >= 0),
 shipping_cost numeric(14,2) not null default 0 check(shipping_cost >= 0), inventory integer not null default 0 check(inventory >= 0),
 ship_to text not null default 'JP', tracking_supported boolean not null default false, last_checked_at timestamptz,
 source_status text not null default 'discovered' check(source_status in ('discovered','verified','unavailable','error')),
 raw_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(supplier_code, supplier_product_id, supplier_variant_id)
);
create table if not exists public.commerce_prices (
 variant_id uuid primary key references public.commerce_variants(id) on delete cascade,
 supplier_offer_id uuid not null references public.supplier_offers(id) on delete cascade,
 currency text not null default 'JPY' check(currency = 'JPY'), selling_price integer not null check(selling_price > 0),
 fee_amount integer not null default 0 check(fee_amount >= 0), expected_profit integer not null,
 margin_rate numeric(7,4) not null, calculated_at timestamptz not null default now()
);
create table if not exists public.channel_listings (
 id uuid primary key default gen_random_uuid(), variant_id uuid not null references public.commerce_variants(id) on delete cascade,
 channel text not null check(channel in ('base','shopify')), external_product_id text, external_variant_id text, external_sku text,
 status text not null default 'pending' check(status in ('pending','published','hidden','error')),
 selling_price integer not null check(selling_price > 0), published_url text, last_error text, last_synced_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(channel, variant_id), unique(channel, external_product_id)
);
create table if not exists public.commerce_orders (
 id uuid primary key default gen_random_uuid(), channel text not null check(channel in ('base','shopify')),
 external_order_id text not null, currency text not null default 'JPY', total_amount integer not null default 0,
 payment_status text not null default 'pending' check(payment_status in ('pending','paid','refunded','cancelled')),
 fulfillment_status text not null default 'unfulfilled' check(fulfillment_status in ('unfulfilled','procurement_pending','ordered','shipped','delivered','failed','cancelled')),
 customer_name text, shipping_address jsonb not null default '{}'::jsonb, raw_payload jsonb not null default '{}'::jsonb,
 received_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(channel, external_order_id)
);
create table if not exists public.commerce_order_lines (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.commerce_orders(id) on delete cascade,
 variant_id uuid references public.commerce_variants(id) on delete set null, external_line_id text not null, sku text,
 quantity integer not null check(quantity > 0), unit_price integer not null check(unit_price >= 0),
 supplier_offer_id uuid references public.supplier_offers(id) on delete set null, created_at timestamptz not null default now(),
 unique(order_id, external_line_id)
);
create table if not exists public.procurement_orders (
 id uuid primary key default gen_random_uuid(), order_line_id uuid not null unique references public.commerce_order_lines(id) on delete cascade,
 supplier_code text not null, supplier_product_id text not null, supplier_variant_id text not null, quantity integer not null check(quantity > 0),
 status text not null default 'pending' check(status in ('pending','submitted','confirmed','shipped','failed','cancelled')),
 external_order_id text unique, tracking_number text, tracking_url text, last_error text, submitted_at timestamptz, shipped_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.commerce_events (
 id bigint generated always as identity primary key, event_key text not null unique, event_type text not null,
 entity_type text not null, entity_id text not null, status text not null default 'ok',
 detail jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists idx_commerce_products_active on public.commerce_products(active, updated_at desc);
create index if not exists idx_commerce_variants_product on public.commerce_variants(product_id);
create index if not exists idx_supplier_offers_variant_stock on public.supplier_offers(variant_id, inventory desc, unit_cost);
create index if not exists idx_supplier_offers_lookup on public.supplier_offers(supplier_code, supplier_product_id, supplier_variant_id);
create index if not exists idx_channel_listings_status on public.channel_listings(channel, status, updated_at);
create index if not exists idx_commerce_orders_fulfillment on public.commerce_orders(payment_status, fulfillment_status, received_at);
create index if not exists idx_procurement_orders_status on public.procurement_orders(status, updated_at);
create index if not exists idx_commerce_events_entity on public.commerce_events(entity_type, entity_id, created_at desc);
alter table public.commerce_products enable row level security;
alter table public.commerce_variants enable row level security;
alter table public.supplier_offers enable row level security;
alter table public.commerce_prices enable row level security;
alter table public.channel_listings enable row level security;
alter table public.commerce_orders enable row level security;
alter table public.commerce_order_lines enable row level security;
alter table public.procurement_orders enable row level security;
alter table public.commerce_events enable row level security;
grant usage on schema public to service_role;
grant all privileges on public.commerce_products, public.commerce_variants, public.supplier_offers, public.commerce_prices, public.channel_listings, public.commerce_orders, public.commerce_order_lines, public.procurement_orders, public.commerce_events to service_role;
grant usage, select on all sequences in schema public to service_role;
