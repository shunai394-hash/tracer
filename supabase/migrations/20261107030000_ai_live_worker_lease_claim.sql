-- Atomically acquire an AI LIVE worker lease. This function is SECURITY INVOKER;
-- only service_role receives EXECUTE, and the table remains inaccessible to end users.
create or replace function public.claim_ai_live_worker_stream(
  p_stream_id text,
  p_owner text,
  p_lease_seconds integer default 45
)
returns setof public.ai_live_worker_streams
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_stream_id is null or p_stream_id !~ '^[A-Za-z0-9_-]{8,96}$' then
    raise exception 'invalid_stream_id' using errcode = '22023';
  end if;
  if p_owner is null or p_owner !~ '^[A-Za-z0-9_-]{8,96}$' then
    raise exception 'invalid_lease_owner' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 300 then
    raise exception 'invalid_lease_seconds' using errcode = '22023';
  end if;

  return query
    update public.ai_live_worker_streams as s
       set lease_owner = p_owner,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           heartbeat_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where s.stream_id = p_stream_id
       and s.status in ('starting', 'live', 'reconnecting')
       and (
         s.lease_expires_at is null
         or s.lease_expires_at <= clock_timestamp()
         or s.lease_owner = p_owner
       )
    returning s.*;
end;
$$;

revoke all on function public.claim_ai_live_worker_stream(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_ai_live_worker_stream(text, text, integer)
  to service_role;
