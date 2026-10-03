-- Matcher persistence hardening.
-- The application uses (demand_observation_id, product_id) as its upsert key;
-- make that key explicit so PostgREST/Supabase can perform a real upsert.
create unique index if not exists demand_product_matches_unique_key
  on public.demand_product_matches (demand_observation_id, product_id);

-- A demand observation can produce at most one candidate for a given query.
-- The existing query-wide unique key remains; this observation-scoped key
-- documents and enforces the matcher invariant directly.
create unique index if not exists demand_product_candidates_observation_query_uidx
  on public.demand_product_candidates (demand_observation_id, query);
