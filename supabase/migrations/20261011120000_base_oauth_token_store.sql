-- Keep BASE OAuth tokens server-side and persist refresh-token rotation.
-- The table lives in a non-API schema; only SECURITY DEFINER RPCs are exposed.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.channel_oauth_tokens (
  provider text primary key check (provider = 'base'),
  refresh_token text not null,
  access_token text,
  access_token_expires_at timestamptz,
  refresh_lease_until timestamptz,
  updated_at timestamptz not null default now()
);
revoke all on table private.channel_oauth_tokens from public, anon, authenticated;
grant select, insert, update, delete on table private.channel_oauth_tokens to service_role;

create or replace function public.seed_channel_oauth_refresh_token(p_provider text, p_refresh_token text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if p_provider <> 'base' or p_refresh_token is null or length(trim(p_refresh_token)) = 0 then
    raise exception 'invalid_channel_oauth_seed';
  end if;
  insert into private.channel_oauth_tokens(provider, refresh_token)
  values (p_provider, trim(p_refresh_token))
  on conflict (provider) do nothing;
end;
$$;

create or replace function public.get_channel_oauth_token_state(p_provider text)
returns table (
  refresh_token text,
  access_token text,
  access_token_expires_at timestamptz,
  refresh_lease_until timestamptz
)
language sql
security definer
set search_path = pg_catalog, private
as $$
  select t.refresh_token, t.access_token, t.access_token_expires_at, t.refresh_lease_until
  from private.channel_oauth_tokens t
  where t.provider = p_provider and p_provider = 'base'
  limit 1;
$$;

create or replace function public.claim_channel_oauth_refresh(p_provider text, p_lease_seconds integer default 30)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare affected integer;
begin
  update private.channel_oauth_tokens
  set refresh_lease_until = now() + make_interval(secs => greatest(5, least(coalesce(p_lease_seconds, 30), 120)))
  where provider = p_provider
    and p_provider = 'base'
    and (refresh_lease_until is null or refresh_lease_until < now());
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.store_channel_oauth_tokens(
  p_provider text,
  p_refresh_token text,
  p_access_token text,
  p_access_token_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if p_provider <> 'base'
    or p_refresh_token is null or length(trim(p_refresh_token)) = 0
    or p_access_token is null or length(trim(p_access_token)) = 0
    or p_access_token_expires_at is null then
    raise exception 'invalid_channel_oauth_token_state';
  end if;
  insert into private.channel_oauth_tokens(
    provider, refresh_token, access_token, access_token_expires_at, refresh_lease_until, updated_at
  ) values (
    p_provider, trim(p_refresh_token), trim(p_access_token), p_access_token_expires_at, null, now()
  )
  on conflict (provider) do update set
    refresh_token = excluded.refresh_token,
    access_token = excluded.access_token,
    access_token_expires_at = excluded.access_token_expires_at,
    refresh_lease_until = null,
    updated_at = now();
end;
$$;

create or replace function public.clear_channel_oauth_access_token(p_provider text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update private.channel_oauth_tokens
  set access_token = null, access_token_expires_at = null, updated_at = now()
  where provider = p_provider and p_provider = 'base';
end;
$$;

create or replace function public.release_channel_oauth_refresh(p_provider text)
returns void
language sql
security definer
set search_path = pg_catalog, private
as $$
  update private.channel_oauth_tokens
  set refresh_lease_until = null, updated_at = now()
  where provider = p_provider and p_provider = 'base';
$$;

revoke all on function public.seed_channel_oauth_refresh_token(text, text) from public, anon, authenticated;
revoke all on function public.get_channel_oauth_token_state(text) from public, anon, authenticated;
revoke all on function public.claim_channel_oauth_refresh(text, integer) from public, anon, authenticated;
revoke all on function public.store_channel_oauth_tokens(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.clear_channel_oauth_access_token(text) from public, anon, authenticated;
revoke all on function public.release_channel_oauth_refresh(text) from public, anon, authenticated;
grant execute on function public.seed_channel_oauth_refresh_token(text, text) to service_role;
grant execute on function public.get_channel_oauth_token_state(text) to service_role;
grant execute on function public.claim_channel_oauth_refresh(text, integer) to service_role;
grant execute on function public.store_channel_oauth_tokens(text, text, text, timestamptz) to service_role;
grant execute on function public.clear_channel_oauth_access_token(text) to service_role;
grant execute on function public.release_channel_oauth_refresh(text) to service_role;
