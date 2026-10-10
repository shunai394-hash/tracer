-- Persist exact ASIN evidence for internal supplier products and variants.
-- ASIN-only marketplace candidates are already admitted by the investigation queue;
-- this makes the identity evidence queryable without inventing a barcode.
alter table public.internal_supply_products
  add column if not exists asin text;

alter table public.internal_supply_variants
  add column if not exists asin text;

create index if not exists internal_supply_products_asin_active_idx
  on public.internal_supply_products (asin)
  where active = true and asin is not null;

create index if not exists internal_supply_variants_asin_active_idx
  on public.internal_supply_variants (asin)
  where active = true and asin is not null;
