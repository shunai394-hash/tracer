-- Ensure PostgREST ON CONFLICT targets can infer the exact uniqueness constraints.
-- PostgreSQL UNIQUE indexes permit multiple NULL values, so these full indexes
-- preserve nullable identifiers while allowing deterministic upserts.
-- Do not make variant_sku unique: suppliers can reuse a SKU across sibling
-- variants, and the ingestion path uses the concrete supplier variant_id.
create unique index if not exists internal_supply_products_source_ref_conflict_uq
  on public.internal_supply_products(source_name, source_ref);

create unique index if not exists internal_supply_variants_product_variant_id_conflict_uq
  on public.internal_supply_variants(supply_product_id, variant_id);
