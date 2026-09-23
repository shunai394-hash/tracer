-- Tracking number for CJ-fulfilled orders, kept separate from the customer's
-- own order status (purchase_orders.supplier_status tracks CJ's side only).
-- Additive only.

alter table public.purchase_orders
  add column if not exists tracking_number text;
