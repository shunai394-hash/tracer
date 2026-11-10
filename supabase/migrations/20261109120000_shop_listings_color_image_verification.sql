-- A supplier variant image URL/VID match is not proof that the photo depicts the selected color.
-- Keep visual color confirmation as a separate, default-deny field.
alter table public.shop_listings
  add column if not exists color_image_verified boolean not null default false;

comment on column public.shop_listings.color_image_verified is
  'True only after visual review confirms this listing image depicts its exact color variant; URL or VID identity alone is insufficient.';
