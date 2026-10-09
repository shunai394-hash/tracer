-- Keep PostgREST ON CONFLICT targets inferable without enforcing supplier SKU uniqueness.
-- CJ may legitimately reuse a SKU across sibling variants; the concrete variant_id is
-- the stable key. PR #152 introduced the full product_id/variant_id index; retain it
-- instead of adding a second, redundant unique index on the same columns.

-- Remove both legacy and PR #152 full SKU uniqueness indexes. SKU is descriptive,
-- not a globally reliable variant identity, and may repeat within a product.
drop index if exists public.internal_supply_variants_product_variant_sku_uq;
drop index if exists public.internal_supply_variants_product_sku_atomic_uq;

-- The partial variant-ID index cannot be inferred by PostgREST's column-only
-- onConflict target. PR #152's full product_id/variant_id index is retained below.
drop index if exists public.internal_supply_variants_product_variant_id_uq;
create unique index if not exists internal_supply_variants_product_id_atomic_uq
  on public.internal_supply_variants(supply_product_id, variant_id);

-- Also ensure the deterministic source key has a full unique index for upsert.
-- PostgreSQL allows multiple NULL values in a normal unique index.
create unique index if not exists internal_supply_products_source_name_ref_atomic_uq
  on public.internal_supply_products(source_name, source_ref);
