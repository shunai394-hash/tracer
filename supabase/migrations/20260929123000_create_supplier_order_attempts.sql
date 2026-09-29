-- Durable idempotency ledger for external supplier order side effects.
-- The supplier execution engine must never retry an ambiguous external result.
create table if not exists public.supplier_order_attempts (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  idempotency_key text not null,
  request_summary jsonb not null default '{}'::jsonb,
  response_code text,
  response_message text,
  supplier_order_id text,
  succeeded boolean not null default false,
  state text not null default 'in_progress'
    check (state in ('in_progress','completed','unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists supplier_order_attempts_idempotency_key_uq
  on public.supplier_order_attempts(idempotency_key);

create unique index if not exists supplier_order_attempts_purchase_order_uq
  on public.supplier_order_attempts(purchase_order_id);

create index if not exists supplier_order_attempts_state_idx
  on public.supplier_order_attempts(state, created_at desc);

alter table public.supplier_order_attempts enable row level security;

revoke all on table public.supplier_order_attempts from anon;
revoke all on table public.supplier_order_attempts from authenticated;
revoke all on table public.supplier_order_attempts from public;
grant all privileges on table public.supplier_order_attempts to service_role;

create or replace function public.tracer_supplier_order_attempts_set_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tracer_supplier_order_attempts_updated_at
  on public.supplier_order_attempts;

create trigger tracer_supplier_order_attempts_updated_at
before update on public.supplier_order_attempts
for each row execute function public.tracer_supplier_order_attempts_set_updated_at();
