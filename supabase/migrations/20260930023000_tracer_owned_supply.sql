create table if not exists public.tracer_supply_catalog (
 id uuid primary key default gen_random_uuid(),
 tracer_sku text not null unique,
 title text not null,
 brand text,
 category text,
 description text,
 image_url text,
 status text not null default 'draft',
 cost numeric,
 shipping_cost numeric not null default 0,
 handling_cost numeric not null default 0,
 sale_price numeric,
 currency text not null default 'JPY',
 inventory integer not null default 0,
 lead_time_days integer,
 tracking_available boolean not null default false,
 orderable boolean not null default false,
 source_type text not null default 'internal',
 source_ref text,
 evidence jsonb not null default '{}'::jsonb,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.tracer_supply_variants (
 id uuid primary key default gen_random_uuid(),
 catalog_id uuid not null references public.tracer_supply_catalog(id) on delete cascade,
 variant_sku text not null unique,
 title text,
 barcode text,
 attributes jsonb not null default '{}'::jsonb,
 cost numeric,
 inventory integer not null default 0,
 orderable boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists tracer_supply_catalog_status_idx on public.tracer_supply_catalog(status,orderable,inventory desc);
create index if not exists tracer_supply_variants_catalog_idx on public.tracer_supply_variants(catalog_id);
