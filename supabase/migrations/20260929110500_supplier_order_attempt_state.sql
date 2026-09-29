-- The supplier execution engine uses state to make concurrent CJ order attempts fail closed.
-- The executor persists attempts in cj_order_attempts; keep the migration aligned
-- with the actual table used by lib/ordering/dropship.ts.
alter table public.cj_order_attempts
  add column if not exists state text not null default 'completed'
    check (state in ('in_progress','completed','unknown'));

create index if not exists cj_order_attempts_state_idx
  on public.cj_order_attempts(state, created_at desc);

grant all privileges on table public.cj_order_attempts to service_role;
