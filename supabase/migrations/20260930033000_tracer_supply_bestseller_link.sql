alter table public.tracer_supply_catalog
  add column if not exists bestseller_id uuid references public.marketplace_bestsellers(id) on delete set null;

create index if not exists tracer_supply_catalog_bestseller_idx
  on public.tracer_supply_catalog(bestseller_id);

alter table public.tracer_supply_catalog enable row level security;
alter table public.tracer_supply_variants enable row level security;

revoke all on table public.tracer_supply_catalog from anon, authenticated;
revoke all on table public.tracer_supply_variants from anon, authenticated;
grant all on table public.tracer_supply_catalog to service_role;
grant all on table public.tracer_supply_variants to service_role;
