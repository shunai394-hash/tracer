-- Per-order human confirmation gate for real CJ order execution.
-- CJ_LIVE_ORDERING=1 is necessary but not sufficient: each individual
-- purchase order also needs an explicit human confirmation before the real
-- supplier.createOrderV2 call is made (see lib/ordering/dropship.ts).
-- Additive only.

alter table public.purchase_orders
  add column if not exists human_confirmed_at timestamptz;

alter table public.purchase_orders
  add column if not exists human_confirmed_by text;
