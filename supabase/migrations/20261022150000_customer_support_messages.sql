create table if not exists public.support_messages (
 id uuid primary key default gen_random_uuid(),
 name text not null, email text not null, category text not null default 'その他',
 subject text not null, message text not null,
 status text not null default 'new' check (status in ('new','in_progress','resolved','spam')),
 admin_note text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists support_messages_status_created_idx on public.support_messages(status,created_at desc);
alter table public.support_messages enable row level security;
revoke all on table public.support_messages from anon, authenticated;
grant all privileges on table public.support_messages to service_role;
comment on table public.support_messages is 'Customer inquiries; server-side service role only.';