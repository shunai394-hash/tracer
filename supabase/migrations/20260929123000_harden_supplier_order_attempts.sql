-- Complete the supplier-agnostic order-attempt schema used by the live execution engine.
-- The original table migration predates the state machine now used by the executor.
alter table public.supplier_order_attempts
  add column if not exists state text not null default 'completed';

update public.supplier_order_attempts
set state = case
  when supplier_order_id is not null and succeeded = true then 'completed'
  else 'unknown'
end
where state = 'completed';

alter table public.supplier_order_attempts
  drop constraint if exists supplier_order_attempts_state_check;

alter table public.supplier_order_attempts
  add constraint supplier_order_attempts_state_check
  check (state in ('in_progress','completed','unknown'));

create index if not exists supplier_order_attempts_state_idx
  on public.supplier_order_attempts(state, created_at desc);

revoke all on table public.supplier_order_attempts from anon;
revoke all on table public.supplier_order_attempts from authenticated;
revoke all on table public.supplier_order_attempts from public;
grant all on table public.supplier_order_attempts to service_role;
