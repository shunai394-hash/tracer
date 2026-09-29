-- The supplier execution engine uses state to make concurrent order attempts fail closed.
alter table public.supplier_order_attempts
  add column if not exists state text not null default 'completed'
    check (state in ('in_progress','completed','unknown'));

create index if not exists supplier_order_attempts_state_idx
  on public.supplier_order_attempts(state, created_at desc);

grant all privileges on table public.supplier_order_attempts to service_role;
