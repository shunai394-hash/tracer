\set ON_ERROR_STOP on
begin;

\ir ../supabase/migrations/20261010190000_internal_supply_link_retry_queue.sql

insert into public.internal_supply_link_retry_queue (
  bestseller_id, supplier_listing_id, supply_variant_id, reason, link_status,
  retry_count, last_attempt_at, next_attempt_at, last_error
) values
  ('bestseller-due', 'supplier-1', 'variant-1', 'canonical_link_unverified', 'readback_failed',
   1, now() - interval '20 minutes', now() - interval '5 minutes', 'simulated readback failure'),
  ('bestseller-future', null, null, 'lookup_failed', 'lookup_failed',
   2, now(), now() + interval '30 minutes', 'simulated lookup failure')
on conflict (bestseller_id) do update set
  supplier_listing_id = excluded.supplier_listing_id,
  supply_variant_id = excluded.supply_variant_id,
  reason = excluded.reason,
  link_status = excluded.link_status,
  retry_count = excluded.retry_count,
  last_attempt_at = excluded.last_attempt_at,
  next_attempt_at = excluded.next_attempt_at,
  last_error = excluded.last_error,
  updated_at = now();

do $$
declare
  due_count integer;
  future_count integer;
  saved_count integer;
begin
  select count(*) into due_count
  from public.internal_supply_link_retry_queue
  where next_attempt_at <= now();

  select count(*) into future_count
  from public.internal_supply_link_retry_queue
  where next_attempt_at > now();

  select count(*) into saved_count
  from public.internal_supply_link_retry_queue
  where bestseller_id = 'bestseller-due'
    and supplier_listing_id = 'supplier-1'
    and supply_variant_id = 'variant-1'
    and reason = 'canonical_link_unverified'
    and link_status = 'readback_failed'
    and retry_count = 1
    and last_error = 'simulated readback failure';

  if due_count <> 1 then
    raise exception 'expected exactly one due retry candidate, got %', due_count;
  end if;
  if future_count <> 1 then
    raise exception 'expected exactly one future retry candidate, got %', future_count;
  end if;
  if saved_count <> 1 then
    raise exception 'retry evidence fields were not persisted together';
  end if;

  insert into public.internal_supply_link_retry_queue (
    bestseller_id, reason, retry_count, next_attempt_at
  ) values ('bestseller-due', 'inventory_unavailable', 2, now() + interval '1 hour')
  on conflict (bestseller_id) do update set
    reason = excluded.reason,
    retry_count = excluded.retry_count,
    next_attempt_at = excluded.next_attempt_at,
    updated_at = now();

  if not exists (
    select 1 from public.internal_supply_link_retry_queue
    where bestseller_id = 'bestseller-due'
      and reason = 'inventory_unavailable'
      and retry_count = 2
      and next_attempt_at > now()
  ) then
    raise exception 'retry upsert did not replace the candidate state';
  end if;
end $$;

rollback;
