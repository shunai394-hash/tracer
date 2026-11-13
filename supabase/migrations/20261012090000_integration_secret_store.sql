create table if not exists public.integration_secret_store (
  provider text not null,
  secret_name text not null,
  encrypted_value text not null,
  updated_at timestamptz not null default now(),
  primary key (provider, secret_name)
);

alter table public.integration_secret_store enable row level security;

-- Secrets are accessed only by the server-side service-role client.
-- Deliberately create no anon/authenticated policies.
revoke all on public.integration_secret_store from anon, authenticated;
grant all on public.integration_secret_store to service_role;
