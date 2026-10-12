-- Read-only audit for unresolved CJ rows with inflated identity confidence.
-- Safe to run against production: SELECT statements only. Do not treat this report as approval
-- to mutate data; review the affected IDs and downstream references before remediation.

with affected as (
  select
    sl.id,
    sl.product_id,
    sl.bestseller_id,
    sl.identity_status,
    sl.identity_method,
    sl.identity_confidence,
    sl.verification_status,
    sl.orderable,
    sl.api_available,
    sl.inventory_confirmed,
    sl.supplier_product_id,
    sl.supplier_variant_id,
    sl.metadata
  from public.supplier_listings sl
  where sl.supplier = 'cj'
    and sl.identity_status = 'supply_discovered'
    and sl.identity_confidence >= 1
),
linked_supplier_products as (
  select distinct product_id
  from public.supplier_listings
  where identity_status = 'linked'
    and product_id is not null
)
select
  count(*) as affected_rows,
  count(*) filter (where a.product_id is not null) as rows_with_provisional_product_id,
  count(*) filter (where a.bestseller_id is not null) as rows_with_bestseller_id,
  count(*) filter (where lsp.product_id is not null) as product_ids_shared_with_any_linked_supplier,
  count(*) filter (where pi.product_id is not null) as product_ids_with_product_intelligence,
  count(*) filter (
    where a.orderable is true
      and a.api_available is true
      and a.inventory_confirmed is true
      and a.verification_status = 'verified'
  ) as rows_with_supplier_flags_that_look_verified
from affected a
left join linked_supplier_products lsp on lsp.product_id = a.product_id
left join public.product_intelligence pi on pi.product_id = a.product_id;

-- Inspect a small sample before proposing any remediation.
select
  sl.id as supplier_listing_id,
  sl.product_id,
  sl.bestseller_id,
  sl.identity_status,
  sl.identity_method,
  sl.identity_confidence,
  sl.verification_status,
  sl.orderable,
  sl.api_available,
  sl.inventory_confirmed,
  sl.supplier_product_id,
  sl.supplier_variant_id,
  sl.metadata ->> 'source_ref' as source_ref,
  sl.metadata ->> 'identity_source' as identity_source,
  sl.metadata ->> 'identity_rationale' as identity_rationale
from public.supplier_listings sl
where sl.supplier = 'cj'
  and sl.identity_status = 'supply_discovered'
  and sl.identity_confidence >= 1
order by sl.fetched_at desc nulls last
limit 25;
