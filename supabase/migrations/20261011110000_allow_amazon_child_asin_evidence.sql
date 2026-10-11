-- Allow a second explicit source of marketplace child-variant evidence:
-- Amazon's embedded child-ASIN variation map plus identifiers extracted from
-- that specific child's own detail page. Parent identifiers are never copied.
alter table public.marketplace_bestseller_variants
  drop constraint if exists marketplace_bestseller_variants_evidence_source_check;

alter table public.marketplace_bestseller_variants
  add constraint marketplace_bestseller_variants_evidence_source_check
  check (evidence_source in (
    'schema_org_product_group_has_variant',
    'amazon_variation_asin_map'
  ));
