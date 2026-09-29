-- Make the supplier-agnostic attempt ledger safe for live execution retries.
alter table public.supplier_order_attempts
  add column if not exists state text not null default 'completed';

alter table public.supplier_order_attempts
  drop constraint if exists supplier_order_attempts_state_check;

alter table public.supplier_order_attempts
  add constraint supplier_order_attempts_state_check
  check (state in ('in_progress', 'completed', 'unknown'));

create index if not exists supplier_order_attempts_state_idx
  on public.supplier_order_attempts(state, created_at desc);

grant all on public.supplier_order_attempts to service_role;
