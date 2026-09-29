create table if not exists public.internal_fulfillment_orders (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete restrict,
  supply_product_id uuid not null references public.internal_supply_products(id) on delete restrict,
  supply_variant_id uuid not null references public.internal_supply_variants(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'queued'
    check (status in ('queued','reserved','processing','shipped','delivered','cancelled','failed')),
  customer_name text,
  shipping_country_code text,
  shipping_province text,
  shipping_city text,
  shipping_line1 text,
  shipping_line2 text,
  shipping_zip text,
  shipping_phone text,
  customer_email text,
  order_number text not null,
  tracking_number text,
  carrier text,
  tracking_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(purchase_order_id),
  unique(order_number)
);

create index if not exists internal_fulfillment_orders_status_idx
  on public.internal_fulfillment_orders(status, created_at);

create index if not exists internal_fulfillment_orders_variant_idx
  on public.internal_fulfillment_orders(supply_variant_id, status);
