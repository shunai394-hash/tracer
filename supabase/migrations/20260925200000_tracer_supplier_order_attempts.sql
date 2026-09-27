-- Generic supplier procurement attempts.
-- Keeps historical CJ attempts intact while giving TRACER its own
-- supplier-agnostic procurement execution history.

create table if not exists public.supplier_order_attempts (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  idempotency_key text not null unique,
  request_summary jsonb not null default '{}'::jsonb,
  response_code text,
  response_message text,
  supplier_order_id text,
  succeeded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists supplier_order_attempts_purchase_order_idx
  on public.supplier_order_attempts(purchase_order_id);

create index if not exists supplier_order_attempts_supplier_order_idx
  on public.supplier_order_attempts(supplier_order_id);

grant all on public.supplier_order_attempts to service_role;
