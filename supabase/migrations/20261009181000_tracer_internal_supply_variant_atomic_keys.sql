-- Non-partial unique indexes are required for PostgREST ON CONFLICT inference.
-- PostgreSQL still permits multiple NULL values, while non-empty keys are unique.
create unique index if not exists internal_supply_variants_product_sku_atomic_uq
  on public.internal_supply_variants(supply_product_id, variant_sku);

create unique index if not exists internal_supply_variants_product_id_atomic_uq
  on public.internal_supply_variants(supply_product_id, variant_id);
