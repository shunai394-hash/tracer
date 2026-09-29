alter table public.tracer_supply_variants
  add column if not exists internal_supply_product_id uuid,
  add column if not exists internal_supply_variant_id uuid;

create index if not exists tracer_supply_variants_internal_supply_variant_idx
  on public.tracer_supply_variants(internal_supply_variant_id)
  where internal_supply_variant_id is not null;

create index if not exists tracer_supply_variants_internal_supply_product_idx
  on public.tracer_supply_variants(internal_supply_product_id)
  where internal_supply_product_id is not null;
