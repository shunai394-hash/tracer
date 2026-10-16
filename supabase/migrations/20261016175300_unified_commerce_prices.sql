create table if not exists public.tc_prices (
  id uuid primary key default gen_random_uuid(),
  supplier_variant_id uuid not null unique references public.tc_supplier_variants(id) on delete cascade,
  currency text not null default 'JPY' check (currency = 'JPY'),
  selling_price numeric(12,2) not null check (selling_price > 0),
  marketplace_fee_rate numeric(7,6) not null check (marketplace_fee_rate >= 0 and marketplace_fee_rate < 1),
  payment_fee_rate numeric(7,6) not null check (payment_fee_rate >= 0 and payment_fee_rate < 1),
  target_margin_rate numeric(7,6) not null check (target_margin_rate >= 0 and target_margin_rate < 1),
  landed_cost_jpy numeric(12,2) not null check (landed_cost_jpy >= 0),
  estimated_fees_jpy numeric(12,2) not null check (estimated_fees_jpy >= 0),
  estimated_profit_jpy numeric(12,2) not null,
  estimated_margin_rate numeric(7,6) not null,
  fx_rate numeric(12,6) not null check (fx_rate > 0),
  calculated_at timestamptz not null default now()
);
create index if not exists tc_prices_calculated_at_idx on public.tc_prices(calculated_at desc);
alter table public.tc_prices enable row level security;
