create table if not exists public.tracer_core_candidates (
 id uuid primary key default gen_random_uuid(),
 bestseller_id uuid references public.marketplace_bestsellers(id) on delete set null,
 canonical_key text not null unique,
 title text not null,
 brand text,
 image_url text,
 source_url text,
 demand_score numeric not null default 0,
 pain_score numeric not null default 0,
 market_gap_score numeric not null default 0,
 supply_score numeric not null default 0,
 margin_score numeric not null default 0,
 competition_score numeric not null default 0,
 identity_confidence numeric not null default 0,
 overall_score numeric not null default 0,
 state text not null default 'DISCOVERED',
 rejection_reason text,
 evidence jsonb not null default '{}'::jsonb,
 metadata jsonb not null default '{}'::jsonb,
 first_seen_at timestamptz not null default now(),
 last_evaluated_at timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.tracer_core_decisions (
 id uuid primary key default gen_random_uuid(),
 candidate_id uuid not null references public.tracer_core_candidates(id) on delete cascade,
 decision text not null,
 score numeric not null default 0,
 gate_results jsonb not null default '{}'::jsonb,
 reasons jsonb not null default '[]'::jsonb,
 created_at timestamptz not null default now()
);
create table if not exists public.tracer_core_runs (
 id uuid primary key default gen_random_uuid(),
 run_type text not null,
 status text not null default 'running',
 processed integer not null default 0,
 discovered integer not null default 0,
 qualified integer not null default 0,
 rejected integer not null default 0,
 published integer not null default 0,
 errors integer not null default 0,
 metrics jsonb not null default '{}'::jsonb,
 started_at timestamptz not null default now(),
 finished_at timestamptz
);
create index if not exists tracer_core_candidates_state_score_idx on public.tracer_core_candidates(state,overall_score desc);
create index if not exists tracer_core_decisions_candidate_idx on public.tracer_core_decisions(candidate_id,created_at desc);
create index if not exists tracer_core_runs_type_started_idx on public.tracer_core_runs(run_type,started_at desc);
