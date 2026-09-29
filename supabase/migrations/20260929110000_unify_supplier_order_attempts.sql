-- Unify supplier order attempt history while preserving existing CJ records.
-- This is bookkeeping/idempotency state only; it never enables live ordering.

alter table public.supplier_order_attempts
  add column if not exists state text not null default 'completed'
    check (state in ('in_progress','completed','unknown'));

insert into public.supplier_order_attempts (
  purchase_order_id,
  idempotency_key,
  request_summary,
  response_code,
  response_message,
  supplier_order_id,
  succeeded,
  state,
  created_at
)
select
  purchase_order_id,
  idempotency_key,
  request_summary,
  response_code,
  response_message,
  supplier_order_id,
  coalesce(succeeded, false),
  coalesce(state, 'completed'),
  created_at
from public.cj_order_attempts
on conflict (idempotency_key) do nothing;

create index if not exists supplier_order_attempts_state_idx
  on public.supplier_order_attempts(state, created_at desc);

grant all privileges on table public.supplier_order_attempts to service_role;
