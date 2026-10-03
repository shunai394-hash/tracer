-- shopping_demand_sync persists observed result counts as a first-class demand signal.
-- Keep the database contract aligned with the pipeline readers/writers.
alter table public.demand_observations
  drop constraint if exists demand_observations_signal_type_check;

alter table public.demand_observations
  add constraint demand_observations_signal_type_check
  check (signal_type in (
    'search_volume',
    'search_growth',
    'search_result_count',
    'social_mentions',
    'review_velocity',
    'sales_rank',
    'other'
  ));
