create table if not exists public.ec_pulse_monitors (
  id uuid primary key default gen_random_uuid(),
  monitor_id text not null unique,
  product_id uuid references public.products(id) on delete set null,
  source_url text not null,
  interval_minutes integer not null,
  webhook_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ec_pulse_monitors_product_id_idx
  on public.ec_pulse_monitors(product_id);

create index if not exists ec_pulse_monitors_source_url_idx
  on public.ec_pulse_monitors(source_url);

alter table public.ec_pulse_monitors enable row level security;

grant all privileges on table public.ec_pulse_monitors
to service_role;
