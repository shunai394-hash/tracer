create table if not exists public.supplier_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  active boolean not null default true,
  order_method text,
  order_automation_status text not null default 'unknown'
    check (order_automation_status in ('unknown','manual','automatable','blocked')),
  payment_automation_status text not null default 'unknown'
    check (payment_automation_status in ('unknown','manual','automatable','blocked')),
  shipping_tracking_status text not null default 'unknown'
    check (shipping_tracking_status in ('unknown','manual','automatable','blocked')),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supplier_product_mappings (
  id uuid primary key default gen_random_uuid(),
  shop_listing_id uuid not null references public.shop_listings(id) on delete cascade,
  supplier_listing_id uuid not null references public.supplier_listings(id) on delete restrict,
  supplier_account_id uuid not null references public.supplier_accounts(id) on delete restrict,
  priority integer not null default 1,
  active boolean not null default true,
  auto_order_enabled boolean not null default false,
  auto_payment_enabled boolean not null default false,
  auto_tracking_enabled boolean not null default false,
  automation_status text not null default 'unverified'
    check (automation_status in ('unverified','testing','eligible','blocked','failed')),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','verified','failed')),
  last_tested_at timestamptz,
  verification_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_listing_id, supplier_listing_id)
);

create index if not exists supplier_product_mappings_shop_active_idx
  on public.supplier_product_mappings (shop_listing_id, active, priority);
create index if not exists supplier_product_mappings_supplier_active_idx
  on public.supplier_product_mappings (supplier_listing_id, active);
create index if not exists supplier_product_mappings_automation_status_idx
  on public.supplier_product_mappings (automation_status, verification_status);

alter table public.supplier_accounts enable row level security;
alter table public.supplier_product_mappings enable row level security;

insert into public.supplier_accounts
  (code, display_name, order_method, order_automation_status, payment_automation_status, shipping_tracking_status)
values
  ('cj','CJ','cj_api','automatable','unknown','automatable'),
  ('superdelivery','SUPER DELIVERY','unknown','unknown','unknown','unknown')
on conflict (code) do update set
  display_name = excluded.display_name,
  updated_at = now();
