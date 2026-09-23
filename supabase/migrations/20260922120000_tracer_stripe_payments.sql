-- Stripe payment confirmation as the single source of truth for order fulfillment.
-- payment_status tracks Stripe's own state; order_status is TRACER's broader
-- fulfillment lifecycle. Neither replaces the existing `status` column, which
-- stays untouched for backward compatibility.
-- Additive only.

alter table public.shop_orders
  add column if not exists payment_status text not null default 'pending'
  check (payment_status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded'));

alter table public.shop_orders
  add column if not exists order_status text not null default 'pending_payment'
  check (order_status in (
    'pending_payment', 'paid', 'fulfillment_pending', 'ordering', 'ordered',
    'shipping', 'delivered', 'cancelled', 'refunded', 'order_failed'
  ));

alter table public.shop_orders
  add column if not exists stripe_checkout_session_id text;

alter table public.shop_orders
  add column if not exists stripe_payment_intent_id text;

alter table public.shop_orders
  add column if not exists paid_at timestamptz;

alter table public.shop_orders
  add column if not exists cancelled_at timestamptz;

alter table public.shop_orders
  add column if not exists refunded_at timestamptz;

alter table public.shop_orders
  add column if not exists refund_amount numeric(14, 4);

create unique index if not exists shop_orders_stripe_checkout_session_idx
  on public.shop_orders(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create unique index if not exists shop_orders_stripe_payment_intent_idx
  on public.shop_orders(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- Webhook idempotency: Stripe's own event id is the dedupe key. A webhook
-- delivered twice (Stripe retries on any non-2xx, or genuinely re-sends)
-- must never be processed twice.
create table if not exists public.stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type text not null,
  shop_order_id uuid references public.shop_orders(id) on delete set null,
  processed boolean not null default false,
  processing_error text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists stripe_webhook_events_order_idx
  on public.stripe_webhook_events(shop_order_id, received_at desc);

alter table public.stripe_webhook_events enable row level security;

grant all privileges on table public.stripe_webhook_events to service_role;
grant all privileges on table public.shop_orders to service_role;
grant usage, select on all sequences in schema public to service_role;
