-- Ensure PostgREST ON CONFLICT targets can infer the uniqueness constraints.
-- The older indexes are partial (WHERE identifier IS NOT NULL); PostgREST's
-- onConflict column list does not specify those predicates. PostgreSQL UNIQUE
-- indexes permit multiple NULL values, so full indexes preserve nullable IDs.
-- Existing partial unique indexes already prevent duplicate non-null keys.
create unique index if not exists internal_supply_products_source_ref_conflict_uq
  on public.internal_supply_products(source_name, source_ref);

create unique index if not exists internal_supply_variants_product_variant_id_conflict_uq
  on public.internal_supply_variants(supply_product_id, variant_id);

create unique index if not exists internal_supply_variants_product_variant_sku_conflict_uq
  on public.internal_supply_variants(supply_product_id, variant_sku);
