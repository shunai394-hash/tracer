-- OAuth refresh tokens are stored only as AES-256-GCM ciphertext.
-- Encryption keys remain in deployment secrets, never in this database.
create table if not exists public.ai_live_oauth_credentials (
  id text primary key check (id = 'youtube_primary'),
  provider text not null check (provider = 'youtube'),
  ciphertext text not null check (length(ciphertext) between 16 and 12000),
  iv text not null check (length(iv) = 16),
  auth_tag text not null check (length(auth_tag) = 24),
  scope text not null,
  updated_at timestamptz not null default now()
);

alter table public.ai_live_oauth_credentials enable row level security;
revoke all on table public.ai_live_oauth_credentials from public, anon, authenticated;
grant select, insert, update on table public.ai_live_oauth_credentials to service_role;
