create table if not exists public.ai_live_drama_casts (
  drama_key text primary key,
  title text not null,
  cast_data jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ai_live_drama_casts enable row level security;
revoke all on public.ai_live_drama_casts from anon, authenticated;
grant select, insert, update, delete on public.ai_live_drama_casts to service_role;
create index if not exists ai_live_drama_casts_updated_at_idx on public.ai_live_drama_casts (updated_at desc);
