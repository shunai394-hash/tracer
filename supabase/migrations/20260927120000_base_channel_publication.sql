alter table public.shop_listings
  add column if not exists base_item_id text,
  add column if not exists base_published_at timestamptz,
  add column if not exists base_last_error text;

create index if not exists shop_listings_base_item_idx
  on public.shop_listings(base_item_id)
  where base_item_id is not null;
