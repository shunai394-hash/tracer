create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  category text not null default 'その他' check (category in ('注文・配送','返品・返金','商品について','決済について','アカウント','その他')),
  subject text not null,
  message text not null,
  status text not null default 'new' check (status in ('new','in_progress','resolved','spam')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_messages_status_created_idx
  on public.support_messages (status, created_at desc);
create index if not exists support_messages_created_idx
  on public.support_messages (created_at desc);

alter table public.support_messages enable row level security;
revoke all on public.support_messages from anon, authenticated;
grant select, insert, update, delete on public.support_messages to service_role;

create or replace function public.set_support_messages_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists support_messages_updated_at on public.support_messages;
create trigger support_messages_updated_at
before update on public.support_messages
for each row execute function public.set_support_messages_updated_at();