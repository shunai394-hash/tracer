-- Align supplier-order attempt state with the generic supplier execution engine.
-- The executor uses public.supplier_order_attempts, not the legacy CJ-only table.
alter table public.supplier_order_attempts
  add column if not exists state text not null default 'completed'
    check (state in ('in_progress','completed','unknown'));

create index if not exists supplier_order_attempts_state_idx
  on public.supplier_order_attempts(state, created_at desc);

grant all privileges on table public.supplier_order_attempts to service_role;
