alter table public.purchase_orders
  add column if not exists human_confirmed_at timestamptz,
  add column if not exists human_confirmed_by text;

comment on column public.purchase_orders.human_confirmed_at is
  'Explicit human approval timestamp before live supplier execution when auto-ordering is disabled.';
comment on column public.purchase_orders.human_confirmed_by is
  'Identifier of the operator who explicitly approved the live supplier order.';