create table if not exists public.customer_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  category text not null check (category in ('注文・配送','返品・返金','商品について','決済について','アカウント','その他')),
  subject text not null,
  message text not null,
  status text not null default 'new' check (status in ('new','in_progress','resolved','spam')),
  admin_note text,
  source text not null default 'contact_form',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_inquiries_status_created_idx
  on public.customer_inquiries (status, created_at desc);
create index if not exists customer_inquiries_created_idx
  on public.customer_inquiries (created_at desc);

alter table public.customer_inquiries enable row level security;
revoke all on public.customer_inquiries from anon, authenticated;
grant select, insert, update, delete on public.customer_inquiries to service_role;

create or replace function public.set_customer_inquiries_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customer_inquiries_updated_at on public.customer_inquiries;
create trigger customer_inquiries_updated_at
before update on public.customer_inquiries
for each row execute function public.set_customer_inquiries_updated_at();