create unique index if not exists internal_supply_products_source_ref_uq
  on public.internal_supply_products(source_name, source_ref)
  where source_ref is not null;

create index if not exists internal_supply_products_active_inventory_idx
  on public.internal_supply_products(active, inventory);

create index if not exists internal_supply_variants_active_inventory_idx
  on public.internal_supply_variants(active, orderable, inventory);
