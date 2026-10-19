-- Keep production channel_listings status values aligned with the commerce core schema.
-- Older databases may have an earlier channel_listings_status_check that rejects 'hidden',
-- causing external unpublishing to succeed while the reconciliation marker fails.
alter table public.channel_listings
  drop constraint if exists channel_listings_status_check;

alter table public.channel_listings
  add constraint channel_listings_status_check
  check (status in ('pending', 'published', 'hidden', 'error'));
