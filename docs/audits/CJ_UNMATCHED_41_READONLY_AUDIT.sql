-- Read-only diagnostic for CJ supplier_listings that do not resolve to commerce_variants.
-- Safe to run in Supabase SQL editor. This file intentionally contains SELECTs only.
-- Do not update or attach rows based on title similarity alone.

-- 1) Summary of the unmatched set and available recovery evidence.
select
  count(*) as unmatched_rows,
  count(*) filter (where nullif(trim(sl.supplier_product_id), '') is not null) as with_supplier_product_id,
  count(*) filter (where nullif(trim(sl.supplier_variant_id), '') is not null) as with_supplier_variant_id,
  count(*) filter (where nullif(trim(sl.metadata->>'variant_barcode'), '') is not null) as with_variant_barcode,
  count(*) filter (where nullif(trim(sl.metadata->>'variant_sku'), '') is not null) as with_variant_sku,
  count(*) filter (where nullif(trim(sl.verification_error), '') is not null) as with_verification_error,
  count(*) filter (where nullif(trim(sl.title), '') = '' or lower(trim(sl.title)) in ('handbag', 'beauty', 'self care')) as generic_title_rows
from public.supplier_listings sl
where sl.supplier = 'cj'
  and not exists (
    select 1 from public.commerce_variants v
    where v.source_variant_key = sl.supplier_variant_id
  );

-- 2) Per-row diagnostics. Candidate counts are evidence only; no links are changed.
select
  sl.id as supplier_listing_id,
  sl.title as supplier_title,
  sl.sku as supplier_sku,
  sl.supplier_product_id,
  sl.supplier_variant_id,
  sl.cj_variant_id,
  sl.metadata->>'variant_barcode' as variant_barcode,
  sl.metadata->>'variant_sku' as metadata_variant_sku,
  sl.verification_status,
  sl.verification_error,
  (
    select count(*) from public.commerce_variants v
    where nullif(trim(sl.metadata->>'variant_barcode'), '') is not null
      and (
        v.attributes->>'barcode' = sl.metadata->>'variant_barcode'
        or v.attributes->>'variant_barcode' = sl.metadata->>'variant_barcode'
      )
  ) as exact_variant_barcode_candidates,
  (
    select count(*) from public.commerce_variants v
    where nullif(trim(sl.metadata->>'variant_sku'), '') is not null
      and lower(trim(v.sku)) = lower(trim(sl.metadata->>'variant_sku'))
  ) as exact_metadata_sku_candidates,
  (
    select count(*) from public.commerce_variants v
    where v.source_variant_key = sl.supplier_product_id
  ) as product_id_as_variant_key_candidates,
  (
    select count(*) from public.commerce_products p
    where p.id::text = sl.product_id::text
  ) as legacy_parent_id_in_canonical_products
from public.supplier_listings sl
where sl.supplier = 'cj'
  and not exists (
    select 1 from public.commerce_variants v
    where v.source_variant_key = sl.supplier_variant_id
  )
order by sl.title, sl.id;

-- 3) Guardrail: the unresolved set must remain unresolved until a unique,
-- supplier-verified parent/child identity can be established.
-- No UPDATE, INSERT, DELETE, or external API calls are performed by this audit.
