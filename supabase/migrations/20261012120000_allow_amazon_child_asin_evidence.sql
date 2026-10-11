-- Permit independently verified Amazon child-ASIN barcode evidence.
-- The collector writes a row only when the child detail page itself yields a concrete barcode.
alter table public.marketplace_bestseller_variants
  drop constraint if exists marketplace_bestseller_variants_evidence_source_check;

alter table public.marketplace_bestseller_variants
  add constraint marketplace_bestseller_variants_evidence_source_check
  check (evidence_source in (
    'schema_org_product_group_has_variant',
    'amazon_variation_asin_map'
  ));
