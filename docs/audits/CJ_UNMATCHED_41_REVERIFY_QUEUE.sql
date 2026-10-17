-- Follow-up read-only audit: whether the 41 unresolved CJ rows can enter
-- the existing bounded identity re-verification queue.
-- This script is SELECT-only; it does not call CJ or mutate data.

-- 1) Eligibility summary against reverify-cj-identity.ts's current queue filters.
select
  sl.verification_status,
  sl.identity_method,
  sl.identity_status,
  sl.verification_error,
  count(*) as row_count,
  count(*) filter (where sl.supplier_variant_id is not null) as with_variant_id,
  count(*) filter (where sl.supplier_product_id is not null) as with_product_id,
  count(*) filter (where sl.verification_status in ('unverified', 'retryable', 'verified')
                    and sl.identity_method in ('supply_discovered', 'none', 'cj_supplier_variant')
                    and sl.supplier_variant_id is not null) as eligible_for_existing_reverify_queue
from public.supplier_listings sl
where sl.supplier = 'cj'
  and not exists (
    select 1 from public.commerce_variants v
    where v.source_variant_key = sl.supplier_variant_id
  )
group by sl.verification_status, sl.identity_method, sl.identity_status, sl.verification_error
order by row_count desc;

-- 2) Exact listing IDs to pass to the existing bounded reverify function.
-- The function currently caps explicit supplierListingIds to 10 per invocation;
-- run one bounded batch at a time only after a human authorizes live CJ lookups.
select
  sl.id as supplier_listing_id,
  sl.supplier_product_id,
  sl.supplier_variant_id,
  sl.verification_status,
  sl.identity_method,
  sl.identity_status,
  sl.verification_error,
  sl.next_verification_at,
  sl.last_verified_at
from public.supplier_listings sl
where sl.supplier = 'cj'
  and not exists (
    select 1 from public.commerce_variants v
    where v.source_variant_key = sl.supplier_variant_id
  )
  and sl.verification_status in ('unverified', 'retryable', 'verified')
  and sl.identity_method in ('supply_discovered', 'none', 'cj_supplier_variant')
  and sl.supplier_variant_id is not null
order by sl.id
limit 41;

-- Note: reverifyCjSupplyIdentities() performs live CJ API reads and can persist
-- refreshed supplier evidence/identity fields. Do not invoke it as a dry run.
-- It must respect the global CJ quota circuit and all native-identity gates.
