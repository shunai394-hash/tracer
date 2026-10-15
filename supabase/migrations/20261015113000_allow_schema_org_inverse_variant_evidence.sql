-- The canonical variant parser emits the inverse Schema.org child relation too.
-- The prior constraint rejected these rows, causing the whole upsert batch to fail
-- whenever a batch contained Product.isVariantOf / inProductGroupWithID evidence.
alter table public.marketplace_bestseller_variants
  drop constraint if exists marketplace_bestseller_variants_evidence_source_check;

alter table public.marketplace_bestseller_variants
  add constraint marketplace_bestseller_variants_evidence_source_check
  check (evidence_source in (
    'schema_org_product_group_has_variant',
    'schema_org_product_is_variant_of',
    'amazon_variation_asin_map'
  ));
