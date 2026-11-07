-- BGM rights ledger. Audio uploads are pending by default and remain private.
create table if not exists public.ai_live_bgm_rights (
  id uuid primary key default gen_random_uuid(),
  storage_object text not null unique,
  title text not null,
  composer text not null,
  source_url text not null,
  source_downloaded_at timestamptz,
  license_name text not null,
  license_url text not null,
  license_checked_at timestamptz not null,
  license_scope text not null check (license_scope in ('internal_stream', 'embedded_platform', 'end_user_secondary_use')),
  commercial_use_allowed boolean not null default false,
  platform_use_allowed boolean not null default false,
  redistribution_allowed boolean not null default false,
  end_user_use_allowed boolean not null default false,
  attribution_required boolean not null default false,
  attribution_text text,
  creator_terms_url text,
  evidence_note text not null,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved_internal', 'approved_platform_users', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  genre text not null default 'daily'
    check (genre in ('daily', 'romance', 'emotional', 'suspense', 'comedy', 'action')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_live_bgm_attribution_text_required
    check (not attribution_required or nullif(btrim(attribution_text), '') is not null),
  constraint ai_live_bgm_approval_requires_review
    check (
      review_status in ('pending', 'rejected')
      or (reviewed_by is not null and reviewed_at is not null)
    ),
  constraint ai_live_bgm_internal_scope_guard
    check (
      review_status <> 'approved_internal'
      or (commercial_use_allowed and platform_use_allowed and license_scope = 'internal_stream')
    ),
  constraint ai_live_bgm_platform_scope_guard
    check (
      review_status <> 'approved_platform_users'
      or (
        commercial_use_allowed and platform_use_allowed
        and end_user_use_allowed
        and license_scope in ('embedded_platform', 'end_user_secondary_use')
      )
    )
);

create index if not exists ai_live_bgm_rights_status_genre_idx
  on public.ai_live_bgm_rights (review_status, genre, created_at desc);

alter table public.ai_live_bgm_rights enable row level security;
revoke all on table public.ai_live_bgm_rights from anon, authenticated;
grant all privileges on table public.ai_live_bgm_rights to service_role;

notify pgrst, 'reload schema';
