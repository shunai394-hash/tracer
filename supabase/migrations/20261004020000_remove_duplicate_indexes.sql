-- Remove exact duplicate unique indexes identified by Supabase advisors.
-- Keep the canonical/index names already referenced by the existing schema.
drop index if exists public.demand_product_matches_unique_key;
drop index if exists public.internal_supply_links_bestseller_product_variant_uq;
drop index if exists public.internal_supply_variants_source_variant_uidx;
