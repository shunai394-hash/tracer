-- Preserve legacy listing rows and their history while preventing channel sync jobs
-- from making archived listings visible again.
alter table public.shop_listings
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

create index if not exists shop_listings_active_unarchived_idx
  on public.shop_listings (updated_at desc)
  where archived_at is null;
