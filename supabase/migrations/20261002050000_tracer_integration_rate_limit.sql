create table if not exists public.integration_rate_limits (
  rate_key text primary key,
  next_allowed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.integration_rate_limits enable row level security;

revoke all on table public.integration_rate_limits from anon, authenticated;

create or replace function public.acquire_integration_rate_slot(
  p_rate_key text,
  p_interval_ms integer default 1100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_slot timestamptz;
  v_wait_ms integer;
begin
  if p_rate_key is null or btrim(p_rate_key) = '' then
    raise exception 'rate_key is required';
  end if;
  if p_interval_ms < 1 or p_interval_ms > 60000 then
    raise exception 'invalid interval_ms';
  end if;

  perform pg_advisory_xact_lock(hashtext('integration-rate:' || p_rate_key));

  insert into public.integration_rate_limits(rate_key, next_allowed_at, updated_at)
  values (p_rate_key, v_now, v_now)
  on conflict (rate_key) do nothing;

  select next_allowed_at
    into v_slot
    from public.integration_rate_limits
   where rate_key = p_rate_key
   for update;

  v_slot := greatest(v_slot, v_now);
  v_wait_ms := greatest(0, ceil(extract(epoch from (v_slot - v_now)) * 1000)::integer);

  update public.integration_rate_limits
     set next_allowed_at = v_slot + make_interval(secs => p_interval_ms / 1000.0),
         updated_at = v_now
   where rate_key = p_rate_key;

  return v_wait_ms;
end;
$$;

revoke all on function public.acquire_integration_rate_slot(text, integer) from public, anon, authenticated;
grant execute on function public.acquire_integration_rate_slot(text, integer) to service_role;
