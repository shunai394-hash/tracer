-- Persist supplier tracking numbers on the canonical purchase order.
-- syncSupplierOrders and supplier reconciliation both write this field.
alter table public.purchase_orders
  add column if not exists tracking_number text;

comment on column public.purchase_orders.tracking_number is
  'Tracking number reported by the supplier adapter; populated only from supplier tracking evidence.';
