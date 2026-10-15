-- Permit the inverse Schema.org relationship emitted by Product.isVariantOf.
-- This remains explicit child evidence; inferred/parent-level identifiers are not accepted.
alter table public.marketplace_bestseller_variants
  drop constraint if exists marketplace_bestseller_variants_evidence_source_check;

alter table public.marketplace_bestseller_variants
  add constraint marketplace_bestseller_variants_evidence_source_check
  check (evidence_source in (
    'schema_org_product_group_has_variant',
    'schema_org_product_is_variant_of',
    'amazon_variation_asin_map'
  ));
