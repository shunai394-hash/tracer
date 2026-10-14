-- Read-only duplicate review. Do not run the commented repair block.
-- Production application of these constraints is unverified.

select idempotency_key,
       count(*) as row_count,
       array_agg(id order by created_at) as attempt_ids,
       array_agg(purchase_order_id order by created_at) as purchase_order_ids,
       array_agg(state order by created_at) as states,
       array_agg(supplier_order_id order by created_at) as supplier_order_ids,
       min(created_at) as first_created_at,
       max(created_at) as last_created_at
from public.supplier_order_attempts
group by idempotency_key
having count(*) > 1
order by min(created_at);

select purchase_order_id,
       count(*) as row_count,
       array_agg(id order by created_at) as attempt_ids,
       array_agg(idempotency_key order by created_at) as idempotency_keys,
       array_agg(state order by created_at) as states,
       array_agg(supplier_order_id order by created_at) as supplier_order_ids,
       min(created_at) as first_created_at,
       max(created_at) as last_created_at
from public.supplier_order_attempts
group by purchase_order_id
having count(*) > 1
order by min(created_at);

select idempotency_key,
       count(*) as row_count,
       array_agg(id order by created_at) as purchase_order_ids,
       array_agg(status order by created_at) as statuses,
       min(created_at) as first_created_at
from public.purchase_orders
where idempotency_key is not null
group by idempotency_key
having count(*) > 1
order by min(created_at);

-- DO NOT RUN. Manual repair after a human picks the surviving row:
-- 1. Copy the non-surviving rows into a review table created for this incident.
-- 2. Leave the surviving row in supplier_order_attempts.
-- 3. Re-run 20261012193000 only after the duplicate groups above return zero rows.
-- create table supplier_order_attempt_duplicate_review as
--   select * from supplier_order_attempts where false;
-- insert into supplier_order_attempt_duplicate_review
--   select * from supplier_order_attempts where id in ('<non-surviving-attempt-id>');
-- delete from supplier_order_attempts where id in ('<non-surviving-attempt-id>');
