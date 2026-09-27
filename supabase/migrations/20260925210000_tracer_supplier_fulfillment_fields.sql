-- Common supplier and fulfillment fields.
-- Additive only: existing supplier_listings/purchase_orders remain the source
-- of truth; these columns make product, variant, orderability, and tracking
-- explicit without inventing values for historical rows.

alter table public.supplier_listings
  add column if not exists supplier_product_id text,
  add column if not exists supplier_variant_id text,
  add column if not exists orderable boolean,
  add column if not exists price_confirmed boolean,
  add column if not exists inventory_confirmed boolean;

alter table public.purchase_orders
  add column if not exists supplier_product_id text,
  add column if not exists supplier_variant_id text,
  add column if not exists tracking_carrier text,
  add column if not exists tracking_url text,
  add column if not exists shipped_at timestamptz;

alter table public.shop_orders
  add column if not exists tracking_number text,
  add column if not exists tracking_carrier text,
  add column if not exists tracking_url text,
  add column if not exists shipped_at timestamptz;

alter table public.shop_listings
  add column if not exists supplier_name text,
  add column if not exists supplier_product_id text,
  add column if not exists supplier_variant_id text,
  add column if not exists source_cost numeric(14,4),
  add column if not exists shipping_cost numeric(14,4),
  add column if not exists inventory integer,
  add column if not exists orderable boolean,
  add column if not exists tracking_available boolean,
  add column if not exists identity_method text,
  add column if not exists identity_confidence numeric(5,4),
  add column if not exists contribution_profit numeric(14,4),
  add column if not exists contribution_margin numeric(14,4);

create index if not exists supplier_listings_supplier_product_idx
  on public.supplier_listings(supplier, supplier_product_id, supplier_variant_id, fetched_at desc);

create index if not exists purchase_orders_supplier_order_idx
  on public.purchase_orders(supplier_name, supplier_order_id);

grant all privileges on table public.supplier_listings to service_role;
grant all privileges on table public.purchase_orders to service_role;
grant all privileges on table public.shop_orders to service_role;
