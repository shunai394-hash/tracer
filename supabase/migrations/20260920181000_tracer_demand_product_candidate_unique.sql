-- Keep one candidate per normalized query.
-- Historical demand_observations are intentionally untouched.

delete from public.demand_product_candidates a
using public.demand_product_candidates b
where a.query = b.query
  and a.id <> b.id
  and a.created_at > b.created_at;

create unique index if not exists
  demand_product_candidates_query_unique_key
  on public.demand_product_candidates(query);
