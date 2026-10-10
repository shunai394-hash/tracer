\set ON_ERROR_STOP on

begin;

\ir ../supabase/migrations/20261010190000_internal_supply_link_retry_queue.sql

insert into public.internal_supply_link_retry_queue (
  bestseller_id, supplier_listing_id, supply_variant_id, reason, link_status,
  retry_count, last_attempt_at, next_attempt_at, last_error
) values
  ('retry-due-test', 'supplier-due-test', 'variant-due-test', 'inventory_unavailable',
   'pending', 2, now() - interval '1 hour', now() - interval '1 minute', 'temporary inventory lookup failure'),
  ('retry-future-test', 'supplier-future-test', 'variant-future-test', 'lookup_failed',
   'pending', 1, now(), now() + interval '1 hour', 'supplier lookup timed out');

do $$
declare
  due_count integer;
  future_count integer;
  stored_reason text;
  stored_supplier text;
  stored_variant text;
begin
  select count(*) into due_count
  from public.internal_supply_link_retry_queue
  where bestseller_id = 'retry-due-test' and next_attempt_at <= now();

  select count(*) into future_count
  from public.internal_supply_link_retry_queue
  where bestseller_id = 'retry-future-test' and next_attempt_at > now();

  if due_count <> 1 then
    raise exception 'Expected exactly one due retry row, got %', due_count;
  end if;
  if future_count <> 1 then
    raise exception 'Expected exactly one future retry row, got %', future_count;
  end if;

  select reason, supplier_listing_id, supply_variant_id
  into stored_reason, stored_supplier, stored_variant
  from public.internal_supply_link_retry_queue
  where bestseller_id = 'retry-due-test';

  if stored_reason <> 'inventory_unavailable'
     or stored_supplier <> 'supplier-due-test'
     or stored_variant <> 'variant-due-test' then
    raise exception 'Retry identity/reason fields did not round-trip together';
  end if;
end $$;

insert into public.internal_supply_link_retry_queue (
  bestseller_id, supplier_listing_id, supply_variant_id, reason, link_status,
  retry_count, last_attempt_at, next_attempt_at, last_error, updated_at
) values (
  'retry-due-test', 'supplier-due-test', 'variant-due-test', 'canonical_link_unverified',
  'unverified', 3, now(), now() + interval '30 minutes', 'readback mismatch', now()
)
on conflict (bestseller_id) do update set
  supplier_listing_id = excluded.supplier_listing_id,
  supply_variant_id = excluded.supply_variant_id,
  reason = excluded.reason,
  link_status = excluded.link_status,
  retry_count = excluded.retry_count,
  last_attempt_at = excluded.last_attempt_at,
  next_attempt_at = excluded.next_attempt_at,
  last_error = excluded.last_error,
  updated_at = excluded.updated_at;

do $$
declare
  actual_reason text;
  actual_status text;
  actual_count integer;
  actual_error text;
  actual_due timestamptz;
begin
  select reason, link_status, retry_count, last_error, next_attempt_at
  into actual_reason, actual_status, actual_count, actual_error, actual_due
  from public.internal_supply_link_retry_queue
  where bestseller_id = 'retry-due-test';

  if actual_reason <> 'canonical_link_unverified'
     or actual_status <> 'unverified'
     or actual_count <> 3
     or actual_error <> 'readback mismatch'
     or actual_due <= now() then
    raise exception 'Retry upsert failed to persist updated state';
  end if;
end $$;

rollback;
