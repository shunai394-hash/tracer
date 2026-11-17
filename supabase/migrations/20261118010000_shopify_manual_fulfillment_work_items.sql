-- Operational queue for TRACER-owned Shopify stock. This is intentionally
-- independent from supplier purchase-order fulfillment.
create table if not exists public.shopify_manual_fulfillment_work_items (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.shopify_manual_stock_reservations(id) on delete restrict,
  shop_order_id uuid not null references public.shop_orders(id) on delete restrict,
  shop_order_item_id uuid not null references public.shop_order_items(id) on delete restrict,
  listing_id uuid not null references public.shop_listings(id) on delete restrict,
  shopify_order_id text not null,
  shopify_line_item_id text not null,
  quantity integer not null check (quantity > 0),
  status text not null default 'queued'
    check (status in ('queued','picking','packed','shipped','delivered','cancelled','failed')),
  carrier text,
  tracking_number text,
  tracking_url text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopify_manual_fulfillment_reservation_unique unique (reservation_id),
  constraint shopify_manual_fulfillment_line_unique unique (shopify_line_item_id)
);

create index if not exists shopify_manual_fulfillment_queue_idx
  on public.shopify_manual_fulfillment_work_items(status, created_at);

create index if not exists shopify_manual_fulfillment_order_idx
  on public.shopify_manual_fulfillment_work_items(shop_order_id, created_at);

alter table public.shopify_manual_fulfillment_work_items enable row level security;
revoke all on public.shopify_manual_fulfillment_work_items from public, anon, authenticated;
grant all on public.shopify_manual_fulfillment_work_items to service_role;
