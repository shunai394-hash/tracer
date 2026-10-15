-- TRACER v2 is additive: preserve existing production tables and records.
create table if not exists public.tracer_v2_pipeline_events (
  id uuid primary key default gen_random_uuid(),
  product_key text not null,
  stage text not null check (stage in (
    'demand_discovered',
    'variant_evidence_saved',
    'supplier_matched',
    'profitability_checked',
    'base_published',
    'shopify_published',
    'newfind_synced',
    'order_received',
    'supplier_order_placed',
    'tracking_synced'
  )),
  outcome text not null check (outcome in ('completed', 'blocked', 'failed')),
  idempotency_key text not null,
  external_id text,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (product_key, idempotency_key)
);

create index if not exists tracer_v2_pipeline_events_product_stage_idx
  on public.tracer_v2_pipeline_events (product_key, created_at);

create index if not exists tracer_v2_pipeline_events_stage_outcome_idx
  on public.tracer_v2_pipeline_events (stage, outcome, created_at desc);

alter table public.tracer_v2_pipeline_events enable row level security;

comment on table public.tracer_v2_pipeline_events is
  'Append-only stage evidence for the additive TRACER v2 pipeline. Writes are performed by the server-side service role; never a substitute for external API verification.';
