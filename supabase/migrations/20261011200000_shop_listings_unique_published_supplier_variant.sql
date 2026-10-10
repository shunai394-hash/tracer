-- Prevent two active storefront listings from selling the same supplier variant.
-- Existing duplicate rows are currently unpublished/blocked; the partial index
-- intentionally allows those historical rows while guaranteeing uniqueness
-- at the actual publication boundary.
create unique index if not exists shop_listings_published_supplier_variant_uidx
  on public.shop_listings (supplier_variant_id)
  where published = true and supplier_variant_id is not null;
