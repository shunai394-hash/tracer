create table if not exists public.cj_api_rate_limit (
  id text primary key,
  next_allowed_at timestamptz not null default now()
);

alter table public.cj_api_rate_limit enable row level security;

create or replace function public.claim_cj_api_slot(
  p_min_interval_ms integer default 1100
)
returns bigint
language plpgsql
as $$
declare
  slot_at timestamptz;
  wait_ms bigint;
begin
  if p_min_interval_ms < 1000 then
    raise exception 'p_min_interval_ms must be >= 1000';
  end if;

  insert into public.cj_api_rate_limit (id, next_allowed_at)
  values ('global', now())
  on conflict (id) do nothing;

  select next_allowed_at
    into slot_at
    from public.cj_api_rate_limit
   where id = 'global'
   for update;

  slot_at := greatest(slot_at, clock_timestamp());
  wait_ms := greatest(
    0,
    floor(extract(epoch from (slot_at - clock_timestamp())) * 1000)
  )::bigint;

  update public.cj_api_rate_limit
     set next_allowed_at = slot_at + (p_min_interval_ms * interval '1 millisecond')
   where id = 'global';

  return wait_ms;
end;
$$;

revoke all on table public.cj_api_rate_limit from anon, authenticated;
grant all privileges on table public.cj_api_rate_limit to service_role;
revoke all on function public.claim_cj_api_slot(integer) from public, anon, authenticated;
grant execute on function public.claim_cj_api_slot(integer) to service_role;
