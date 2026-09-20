alter table public.demand_observations
alter column product_id drop not null;

create index if not exists demand_observations_product_id_idx
  on public.demand_observations(product_id);
