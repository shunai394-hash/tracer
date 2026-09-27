-- Concurrency hardening for external side effects.
-- Prevent duplicate BASE publication claims, NEWFIND deliveries, and CJ attempts.

alter table public.shop_listings
  add column if not exists base_publication_status text
    check (base_publication_status in ('pending','creating','published','failed')),
  add column if not exists base_publication_lease_until timestamptz;

create index if not exists shop_listings_base_publication_claim_idx
  on public.shop_listings(base_publication_status, base_publication_lease_until)
  where published = true;

alter table public.newfind_promotion_deliveries
  drop constraint if exists newfind_promotion_deliveries_status_check;

alter table public.newfind_promotion_deliveries
  add constraint newfind_promotion_deliveries_status_check
  check (status in ('pending','sending','sent','processed','failed'));

alter table public.newfind_promotion_deliveries
  add column if not exists lease_until timestamptz;

create index if not exists newfind_promotion_deliveries_claim_idx
  on public.newfind_promotion_deliveries(status, lease_until, updated_at);

alter table public.cj_order_attempts
  add column if not exists state text not null default 'completed'
    check (state in ('in_progress','completed','unknown'));

alter table public.purchase_order_items
  add column if not exists idempotency_key text;

create unique index if not exists purchase_order_items_idempotency_key_idx
  on public.purchase_order_items(idempotency_key)
  where idempotency_key is not null;
