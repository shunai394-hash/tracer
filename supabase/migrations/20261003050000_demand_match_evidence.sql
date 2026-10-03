-- Demand match evidence (additive only; no existing row is changed or deleted).
--
-- demand_product_matches previously allowed only keyword/category/brand/
-- semantic/manual and had no evidence columns, so the matcher's writes failed
-- and the table stayed empty. The matcher now falls back to the legacy
-- columns (evidence carried in rationale) until this migration is applied.

alter table public.demand_product_matches
  add column if not exists evidence_type text,
  add column if not exists evidence jsonb,
  add column if not exists source_id text;

alter table public.demand_product_matches
  drop constraint if exists demand_product_matches_match_method_check;

alter table public.demand_product_matches
  add constraint demand_product_matches_match_method_check
  check (match_method in (
    -- legacy values, kept so existing rows stay valid
    'keyword',
    'category',
    'brand',
    'semantic',
    'manual',
    -- identifier-grade (strong) evidence
    'exact_jan',
    'exact_gtin',
    'exact_model',
    'exact_brand_model',
    'verified_source_mapping',
    -- weak evidence, never sufficient for demand on its own
    'normalized_title',
    'weak_text_similarity',
    'search_provenance'
  ));

alter table public.demand_product_matches
  drop constraint if exists demand_product_matches_evidence_type_check;

alter table public.demand_product_matches
  add constraint demand_product_matches_evidence_type_check
  check (evidence_type is null or evidence_type in ('identifier', 'weak'));
