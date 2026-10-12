-- Track when supplier price evidence was actually observed.
-- Leave existing rows NULL: historical prices must not be treated as freshly verified.
alter table public.supplier_listings
  add column if not exists price_checked_at timestamptz;

-- The Shopify sync gate rejects missing/stale price timestamps. Existing
-- listings become eligible again only after inventory-refresh obtains fresh
-- price evidence for the exact supplier variant.
grant all privileges on table public.supplier_listings to service_role;
