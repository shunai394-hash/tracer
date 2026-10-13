-- Restore the idempotency unique index removed as "redundant" by
-- 20260929130000, and refuse to continue when duplicate groups already exist.
-- This statement set does not delete, merge, or overwrite attempt rows.
-- If duplicates exist, the exception stops the migration for manual review.

do $$
declare
  duplicate_keys bigint;
  duplicate_purchase_orders bigint;
begin
  select count(*) into duplicate_keys from (
    select idempotency_key
    from public.supplier_order_attempts
    group by idempotency_key
    having count(*) > 1
  ) duplicate_key_groups;
  select count(*) into duplicate_purchase_orders from (
    select purchase_order_id
    from public.supplier_order_attempts
    group by purchase_order_id
    having count(*) > 1
  ) duplicate_purchase_order_groups;
  if duplicate_keys > 0 or duplicate_purchase_orders > 0 then
    raise exception
      'supplier_order_attempts has duplicate groups (idempotency_keys=%, purchase_orders=%). Unique indexes were not created. Review scripts/review-supplier-order-duplicate-groups.sql and resolve the rows manually.',
      duplicate_keys,
      duplicate_purchase_orders;
  end if;
end $$;

create unique index if not exists supplier_order_attempts_idempotency_key_uq
  on public.supplier_order_attempts(idempotency_key);

create unique index if not exists supplier_order_attempts_purchase_order_uq
  on public.supplier_order_attempts(purchase_order_id);
