-- Customer cancellation / refund lifecycle for first-party shop orders.
alter table public.shop_orders
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_reason text,
  add column if not exists cancellation_source text,
  add column if not exists refund_id text,
  add column if not exists refund_requested_at timestamptz;

alter table public.shop_orders
  drop constraint if exists shop_orders_order_status_check;

alter table public.shop_orders
  add constraint shop_orders_order_status_check check (order_status in (
    'pending_payment', 'paid', 'fulfillment_pending', 'ordering', 'ordered',
    'shipping', 'delivered', 'cancelled', 'cancellation_requested',
    'refund_pending', 'refunded', 'order_failed'
  ));

create unique index if not exists shop_orders_refund_id_idx
  on public.shop_orders(refund_id)
  where refund_id is not null;

create index if not exists shop_orders_cancellation_idx
  on public.shop_orders(order_status, cancellation_requested_at desc);
