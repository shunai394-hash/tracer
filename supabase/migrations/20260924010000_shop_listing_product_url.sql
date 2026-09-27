alter table public.shop_listings
  add column if not exists product_url text;

grant all privileges on table public.shop_listings to service_role;
