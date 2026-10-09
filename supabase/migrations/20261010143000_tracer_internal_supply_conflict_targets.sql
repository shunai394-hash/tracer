-- Ensure PostgREST ON CONFLICT targets can infer full uniqueness constraints.
-- Existing production indexes are partial and cannot be inferred from an onConflict
-- column list without the predicate. Replace them with full indexes.
-- Do not retain SKU uniqueness: CJ can reuse a SKU across sibling variants.
-- variant_id, not SKU, is the stable variant identity.

-- This partial index rejects legitimate sibling variants sharing one supplier SKU.
drop index if exists public.internal_supply_variants_product_variant_sku_uq;

-- Replace the partial variant-ID index with a full index for PostgREST upserts.
drop index if exists public.internal_supply_variants_product_variant_id_uq;
create unique index if not exists internal_supply_variants_product_variant_id_conflict_uq
  on public.internal_supply_variants(supply_product_id, variant_id);

-- The product source_ref partial index may coexist until this full conflict target
-- is installed; PostgreSQL permits multiple NULLs in a normal unique index.
create unique index if not exists internal_supply_products_source_name_ref_atomic_uq
  on public.internal_supply_products(source_name, source_ref);
