create unique index if not exists internal_supply_variants_product_variant_sku_uq
  on public.internal_supply_variants(supply_product_id, variant_sku)
  where variant_sku is not null;

create unique index if not exists internal_supply_variants_product_variant_id_uq
  on public.internal_supply_variants(supply_product_id, variant_id)
  where variant_id is not null;

create unique index if not exists internal_supply_links_bestseller_product_variant_uq
  on public.internal_supply_links(bestseller_id, supply_product_id, supply_variant_id);
