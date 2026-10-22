-- Allow TRACER-owned stock and storefront publishing without treating a Shopify/CJ link as inventory authority.
alter table public.shop_listings
  add column if not exists manual_inventory boolean not null default false;

create index if not exists shop_listings_manual_published_idx
  on public.shop_listings (published, published_at desc)
  where manual_inventory = true and archived_at is null;
