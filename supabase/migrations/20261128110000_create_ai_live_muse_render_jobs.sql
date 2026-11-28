create extension if not exists pgcrypto;

create table if not exists public.ai_live_muse_render_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued' check (status in ('queued','processing','succeeded','failed')),
  manifest jsonb not null,
  asset_paths jsonb not null default '[]'::jsonb,
  output_path text,
  output_video_url text,
  error_message text,
  requested_by text not null default 'muse',
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  lease_token uuid,
  leased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint muse_render_assets_array check (jsonb_typeof(asset_paths) = 'array'),
  constraint muse_render_manifest_object check (jsonb_typeof(manifest) = 'object')
);

create index if not exists ai_live_muse_render_queue_idx
  on public.ai_live_muse_render_jobs (created_at asc) where status = 'queued';

alter table public.ai_live_muse_render_jobs enable row level security;
revoke all on public.ai_live_muse_render_jobs from anon, authenticated;
grant select, insert, update on public.ai_live_muse_render_jobs to service_role;

create or replace function public.claim_ai_live_muse_render_job()
returns setof public.ai_live_muse_render_jobs
language plpgsql security definer set search_path = public
as $$
declare claimed public.ai_live_muse_render_jobs;
begin
  update public.ai_live_muse_render_jobs
     set status = 'failed', lease_token = null,
         error_message = 'Worker lease expired after maximum attempts',
         completed_at = now(), updated_at = now()
   where status = 'processing' and leased_at < now() - interval '30 minutes'
     and attempt_count >= 5;

  update public.ai_live_muse_render_jobs
     set status = 'queued', lease_token = null, leased_at = null, updated_at = now()
   where status = 'processing' and leased_at < now() - interval '30 minutes'
     and attempt_count < 5;

  with candidate as (
    select id from public.ai_live_muse_render_jobs
     where status = 'queued' and attempt_count < 5
     order by created_at asc for update skip locked limit 1
  )
  update public.ai_live_muse_render_jobs j
     set status = 'processing', lease_token = gen_random_uuid(),
         leased_at = now(), attempt_count = attempt_count + 1, updated_at = now()
    from candidate where j.id = candidate.id returning j.* into claimed;

  if claimed.id is not null then return next claimed; end if;
  return;
end;
$$;

revoke all on function public.claim_ai_live_muse_render_job() from public, anon, authenticated;
grant execute on function public.claim_ai_live_muse_render_job() to service_role;
notify pgrst, 'reload schema';
