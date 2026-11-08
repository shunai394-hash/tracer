create table if not exists public.ai_live_drama_projects (
  project_key text primary key,
  title text not null,
  episode_number integer not null default 1 check (episode_number between 1 and 999),
  genre text not null default '',
  project_data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ai_live_drama_projects enable row level security;
revoke all on public.ai_live_drama_projects from anon, authenticated;
grant select, insert, update, delete on public.ai_live_drama_projects to service_role;
create index if not exists ai_live_drama_projects_updated_at_idx on public.ai_live_drama_projects (updated_at desc);
