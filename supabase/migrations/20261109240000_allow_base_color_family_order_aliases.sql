-- BASE legacy item IDs must resolve to canonical variants after color-family consolidation.
-- Shopify aliases were the only allowed channel before BASE order ingestion gained alias lookup.
alter table public.channel_listing_external_aliases
  drop constraint if exists channel_listing_external_aliases_channel_check;

alter table public.channel_listing_external_aliases
  add constraint channel_listing_external_aliases_channel_check
  check (channel in ('shopify', 'base'));
