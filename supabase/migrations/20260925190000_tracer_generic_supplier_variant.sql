-- Generic supplier variant identifiers.
-- Keeps existing supplier data on the generic supplier_variant_id field.

alter table public.purchase_order_items
  add column if not exists supplier_variant_id text;

alter table public.supplier_listings
  add column if not exists supplier_variant_id text;
