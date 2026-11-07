-- YouTube RTMP ingest credentials are encrypted at the worker boundary.
-- The encryption key is held only in the isolated worker's deployment secrets.
create table if not exists public.ai_live_stream_secrets (
  id text primary key check (id ~* '^[0-9a-f-]{36}$'),
  platform text not null check (platform = 'youtube'),
  stream_id text not null check (length(stream_id) between 1 and 256),
  ciphertext text not null check (length(ciphertext) between 16 and 12000),
  iv text not null check (length(iv) = 16),
  auth_tag text not null check (length(auth_tag) = 24),
  created_at timestamptz not null default now()
);

create index if not exists ai_live_stream_secrets_stream_id_idx
  on public.ai_live_stream_secrets (stream_id);

alter table public.ai_live_stream_secrets enable row level security;
revoke all on table public.ai_live_stream_secrets from public, anon, authenticated;
grant select, insert, delete on table public.ai_live_stream_secrets to service_role;
