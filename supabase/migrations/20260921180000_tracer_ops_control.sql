-- Operational control: kill switches, order idempotency, cron run logging.
-- Additive only. Existing tables stay intact.

create table if not exists public.kill_switches (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'supplier', 'product', 'user')),
  scope_key text not null default '',
  active boolean not null default false,
  reason text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope, scope_key)
);

insert into public.kill_switches (scope, scope_key, active)
values ('global', '', false)
on conflict (scope, scope_key) do nothing;

create index if not exists kill_switches_scope_idx
  on public.kill_switches(scope, active);

-- Purchase order idempotency + live-order tracking for real supplier execution.
alter table public.purchase_orders
  add column if not exists idempotency_key text;

alter table public.purchase_orders
  add column if not exists live_order boolean not null default false;

alter table public.purchase_orders
  add column if not exists supplier_status text;

alter table public.purchase_orders
  add column if not exists supplier_synced_at timestamptz;

create unique index if not exists purchase_orders_idempotency_key_idx
  on public.purchase_orders(idempotency_key)
  where idempotency_key is not null;

create table if not exists public.cj_order_attempts (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid references public.purchase_orders(id) on delete cascade,
  idempotency_key text not null,
  request_summary jsonb not null default '{}'::jsonb,
  response_code text,
  response_message text,
  supplier_order_id text,
  succeeded boolean,
  created_at timestamptz not null default now(),
  unique (idempotency_key)
);

create index if not exists cj_order_attempts_po_idx
  on public.cj_order_attempts(purchase_order_id, created_at desc);

create table if not exists public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  processed integer,
  failed integer,
  retried integer,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists cron_runs_job_idx
  on public.cron_runs(job_name, started_at desc);

alter table public.kill_switches enable row level security;
alter table public.cj_order_attempts enable row level security;
alter table public.cron_runs enable row level security;

grant all privileges on table public.kill_switches to service_role;
grant all privileges on table public.cj_order_attempts to service_role;
grant all privileges on table public.cron_runs to service_role;
grant all privileges on table public.purchase_orders to service_role;
grant usage, select on all sequences in schema public to service_role;
