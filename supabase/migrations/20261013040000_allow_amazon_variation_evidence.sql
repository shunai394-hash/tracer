-- Keep the canonical-variant evidence constraint aligned with every explicit
-- evidence source emitted by the collector. Do not drop Product.isVariantOf
-- evidence when adding Amazon child-ASIN evidence, and continue rejecting
-- inferred sources that have no concrete child-level relationship.
alter table public.marketplace_bestseller_variants
  drop constraint if exists marketplace_bestseller_variants_evidence_source_check;

alter table public.marketplace_bestseller_variants
  add constraint marketplace_bestseller_variants_evidence_source_check
  check (evidence_source in (
    'schema_org_product_group_has_variant',
    'schema_org_product_is_variant_of',
    'amazon_variation_asin_map'
  ));
