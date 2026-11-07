-- Durable AI LIVE worker state. Credentials are never stored here; only opaque secret refs.
create table if not exists public.ai_live_worker_streams (
  stream_id text primary key check (stream_id ~ '^[A-Za-z0-9_-]{8,96}$'),
  destination text not null check (destination in ('youtube_live', 'tiktok_live')),
  status text not null check (status in ('starting', 'live', 'reconnecting', 'stopped', 'failed')),
  adapter_mode text not null default 'fake' check (adapter_mode in ('fake', 'live')),
  job_fingerprint text not null check (length(job_fingerprint) = 64),
  job_payload jsonb not null,
  active_segment_index integer not null default 0 check (active_segment_index >= 0),
  active_product_id text,
  reconnect_count integer not null default 0 check (reconnect_count >= 0),
  heartbeat_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  stop_reason text,
  updated_at timestamptz not null default now(),
  constraint ai_live_worker_segment_in_payload check (
    jsonb_typeof(job_payload->'segments') = 'array'
    and jsonb_array_length(job_payload->'segments') > active_segment_index
  ),
  constraint ai_live_worker_no_inline_stream_keys check (
    not (job_payload ?| array['rtmpUrl','streamKey','stream_key','accessToken','access_token','cookie','destinationUrl','destination_url'])
  )
);

create index if not exists ai_live_worker_streams_status_lease_idx
  on public.ai_live_worker_streams (status, lease_expires_at);

create index if not exists ai_live_worker_streams_heartbeat_idx
  on public.ai_live_worker_streams (heartbeat_at desc);

alter table public.ai_live_worker_streams enable row level security;
revoke all on table public.ai_live_worker_streams from public, anon, authenticated;
grant select, insert, update on table public.ai_live_worker_streams to service_role;
