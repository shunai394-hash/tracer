create extension if not exists pgcrypto;

create table if not exists public.ai_live_musetalk_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued' check (status in ('queued','processing','succeeded','failed')),
  input_image_url text not null,
  input_audio_url text not null,
  output_video_url text,
  error_message text,
  requested_by text not null default 'muse',
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  lease_token uuid,
  leased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ai_live_musetalk_image_https check (input_image_url ~ '^https://'),
  constraint ai_live_musetalk_audio_https check (input_audio_url ~ '^https://'),
  constraint ai_live_musetalk_output_https check (output_video_url is null or output_video_url ~ '^https://')
);

create index if not exists ai_live_musetalk_jobs_queue_idx
  on public.ai_live_musetalk_jobs (created_at asc)
  where status = 'queued';
create index if not exists ai_live_musetalk_jobs_owner_idx
  on public.ai_live_musetalk_jobs (requested_by, created_at desc);

alter table public.ai_live_musetalk_jobs enable row level security;
revoke all on public.ai_live_musetalk_jobs from anon, authenticated;
grant select, insert, update on public.ai_live_musetalk_jobs to service_role;

create or replace function public.claim_ai_live_musetalk_job()
returns setof public.ai_live_musetalk_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.ai_live_musetalk_jobs;
begin
  update public.ai_live_musetalk_jobs
     set status = 'queued', lease_token = null, leased_at = null,
         updated_at = now()
   where status = 'processing'
     and leased_at < now() - interval '30 minutes'
     and attempt_count < 5;

  with candidate as (
    select id from public.ai_live_musetalk_jobs
     where status = 'queued' and attempt_count < 5
     order by created_at asc
     for update skip locked
     limit 1
  )
  update public.ai_live_musetalk_jobs j
     set status = 'processing',
         lease_token = gen_random_uuid(),
         leased_at = now(),
         attempt_count = attempt_count + 1,
         updated_at = now()
    from candidate
   where j.id = candidate.id
   returning j.* into claimed;

  if claimed.id is not null then
    return next claimed;
  end if;
  return;
end;
$$;

revoke all on function public.claim_ai_live_musetalk_job() from public, anon, authenticated;
grant execute on function public.claim_ai_live_musetalk_job() to service_role;

notify pgrst, 'reload schema';
