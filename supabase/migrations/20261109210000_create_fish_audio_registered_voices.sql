create table if not exists public.fish_audio_registered_voices (
  model_id text primary key,
  title text not null check (char_length(title) between 1 and 60),
  model_type text not null default 'tts',
  model_state text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fish_audio_registered_voices enable row level security;
revoke all on table public.fish_audio_registered_voices from anon, authenticated;
grant select, insert, update, delete on table public.fish_audio_registered_voices to service_role;

create index if not exists fish_audio_registered_voices_updated_at_idx
  on public.fish_audio_registered_voices (updated_at desc);
