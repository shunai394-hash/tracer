-- Keep the persisted publication state consistent with the unpublish reconciliation flow.
-- Production currently rejects `hidden`, which causes verified BASE hides to be
-- reported as failures after the external API has already confirmed the hide.
alter table public.channel_listings
  drop constraint if exists channel_listings_status_check;

alter table public.channel_listings
  add constraint channel_listings_status_check
  check (status in ('pending', 'published', 'hidden', 'error'));
