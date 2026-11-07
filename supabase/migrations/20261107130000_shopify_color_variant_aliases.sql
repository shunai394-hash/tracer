-- Shopify color consolidation uses one external parent product ID for multiple
-- canonical color variants. The existing unique key is (channel, variant_id),
-- which must remain: it protects one current channel listing per canonical variant.
-- There is no unique constraint on external_product_id to remove.
create index if not exists idx_channel_listings_channel_external_product_id
  on public.channel_listings(channel, external_product_id)
  where external_product_id is not null;

-- Historical Shopify variant IDs remain valid order-line identities after a
-- color family is moved to a new parent product. These aliases are identity
-- records; current publication state remains in channel_listings.
create table if not exists public.channel_listing_external_aliases (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel = 'shopify'),
  variant_id uuid not null references public.commerce_variants(id) on delete cascade,
  external_product_id text not null,
  external_variant_id text not null,
  created_at timestamptz not null default now(),
  unique(channel, external_variant_id)
);

create index if not exists idx_channel_listing_external_aliases_variant
  on public.channel_listing_external_aliases(channel, variant_id);

alter table public.channel_listing_external_aliases enable row level security;
grant all privileges on public.channel_listing_external_aliases to service_role;
