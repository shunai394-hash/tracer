-- Append-only evidence ledger for TRACER commerce bot runs.
-- Additive migration: does not alter or delete existing commerce tables.
create table if not exists public.commerce_bot_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  bot_id text not null check (bot_id in ('main', 'product-monitor', 'japanese-copy', 'channel-sync', 'qa')),
  event_type text not null check (event_type in ('run_started', 'evidence_recorded', 'blocked', 'passed', 'partial', 'failed', 'run_finished')),
  status text not null check (status in ('not-run', 'running', 'passed', 'blocked', 'partial', 'failed')),
  occurred_at timestamptz not null default now(),
  input_snapshot_hash text,
  evidence_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_refs) = 'array'),
  blockers jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  retry_count integer not null default 0 check (retry_count >= 0),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  constraint commerce_bot_run_events_idempotency_key_unique unique (idempotency_key)
);

create index if not exists commerce_bot_run_events_run_id_occurred_at_idx
  on public.commerce_bot_run_events (run_id, occurred_at desc);
create index if not exists commerce_bot_run_events_bot_id_occurred_at_idx
  on public.commerce_bot_run_events (bot_id, occurred_at desc);

alter table public.commerce_bot_run_events enable row level security;
revoke all on table public.commerce_bot_run_events from anon, authenticated;
grant select, insert on table public.commerce_bot_run_events to service_role;

-- Evidence is immutable: subsequent state transitions append new events instead
-- of rewriting prior evidence. The service role cannot update or delete rows.
revoke update, delete, truncate, references, trigger on table public.commerce_bot_run_events from service_role;
