-- TRACER policy: Amazon and Rakuten are no longer approved market-data sources.
-- Remove their observation records and source-specific evidence. Canonical products,
-- direct supplier records, customer orders, and channel records are intentionally
-- preserved; they may have independent supplier/commerce evidence and must not be
-- destroyed merely because an old marketplace observation once referenced them.
begin;

create temporary table tracer_removed_marketplace_rows on commit drop as
select id
from public.marketplace_bestsellers
where lower(trim(marketplace)) in ('amazon.co.jp', 'amazon', 'rakuten');

-- Remove candidates and decisions whose only parent evidence is being removed.
delete from public.tracer_core_candidates
where bestseller_id in (select id from tracer_removed_marketplace_rows);

-- Remove evidence that is explicitly tied to the removed marketplace observations.
delete from public.evidence_ledger
where bestseller_id in (select id from tracer_removed_marketplace_rows)
   or lower(source) like '%amazon%'
   or lower(source) like '%rakuten%';

delete from public.product_identifiers
where bestseller_id in (select id from tracer_removed_marketplace_rows)
   or lower(source) like '%amazon%'
   or lower(source) like '%rakuten%';

-- Child variant rows cascade with their parent bestseller row.
delete from public.marketplace_bestsellers
where id in (select id from tracer_removed_marketplace_rows);

-- Defensive cleanup: remove orphaned marketplace variant evidence from these sources
-- even if a parent row had already been relabeled by an earlier pipeline.
delete from public.marketplace_bestseller_variants
where lower(trim(marketplace)) in ('amazon.co.jp', 'amazon', 'rakuten')
   or lower(source) like '%amazon%'
   or lower(source) like '%rakuten%';

commit;
