-- Per-channel lease for serializing TRACER downstream writes.
-- Additive only; this migration is not applied automatically by this PR.
create table if not exists public.commerce_channel_leases (
  channel_id text primary key check (channel_id in ('base', 'shopify', 'newfind')),
  lease_token uuid not null,
  owner_run_id uuid not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint commerce_channel_leases_expiry_after_acquire
    check (expires_at > acquired_at)
);

alter table public.commerce_channel_leases enable row level security;
revoke all on table public.commerce_channel_leases from anon, authenticated;
grant select, insert, update, delete on table public.commerce_channel_leases to service_role;

-- Atomic lease acquisition: succeeds only if no lease exists or the prior lease expired.
-- Caller supplies a fresh random lease token and a bounded expiry.
create or replace function public.acquire_commerce_channel_lease(
  p_channel_id text,
  p_lease_token uuid,
  p_owner_run_id uuid,
  p_lease_seconds integer default 300
)
returns table (acquired boolean, expires_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_expires_at timestamptz := now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)));
begin
  if p_channel_id not in ('base', 'shopify', 'newfind') then
    raise exception 'invalid_channel_id';
  end if;
  if p_lease_token is null or p_owner_run_id is null then
    raise exception 'lease_token_and_owner_run_id_required';
  end if;

  return query
  insert into public.commerce_channel_leases as current_lease
    (channel_id, lease_token, owner_run_id, acquired_at, expires_at, updated_at)
  values
    (p_channel_id, p_lease_token, p_owner_run_id, now(), v_expires_at, now())
  on conflict (channel_id) do update
    set lease_token = excluded.lease_token,
        owner_run_id = excluded.owner_run_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        updated_at = now()
    where current_lease.expires_at <= now()
  returning true, commerce_channel_leases.expires_at;

  if not found then
    return query select false, current_lease.expires_at
      from public.commerce_channel_leases as current_lease
      where current_lease.channel_id = p_channel_id;
  end if;
end;
$$;

-- Release is token-checked so an expired/replaced lease cannot be released by an old owner.
create or replace function public.release_commerce_channel_lease(
  p_channel_id text,
  p_lease_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.commerce_channel_leases
    where channel_id = p_channel_id
      and lease_token = p_lease_token;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.acquire_commerce_channel_lease(text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_commerce_channel_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_commerce_channel_lease(text, uuid, uuid, integer) to service_role;
grant execute on function public.release_commerce_channel_lease(text, uuid) to service_role;
