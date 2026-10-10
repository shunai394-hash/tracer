-- ASIN is retained for marketplace candidate lookup only.
-- It is not proof of supplier product/variant identity and cannot pass the Sales Test Gate alone.
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
