-- Chrome Extension capture source.
-- Additive only: existing TRACER product, observation and identifier tables are reused.

create index if not exists products_asin_idx
  on public.products(asin)
  where asin is not null;

create index if not exists products_jan_idx
  on public.products(jan)
  where jan is not null;

create index if not exists products_gtin_idx
  on public.products(gtin)
  where gtin is not null;

create index if not exists products_ean_idx
  on public.products(ean)
  where ean is not null;

create index if not exists products_upc_idx
  on public.products(upc)
  where upc is not null;

create index if not exists products_mpn_idx
  on public.products(mpn)
  where mpn is not null;

grant all privileges on table public.products to service_role;
grant all privileges on table public.sources to service_role;
grant all privileges on table public.observations to service_role;
grant all privileges on table public.price_observations to service_role;
grant all privileges on table public.product_identifiers to service_role;
