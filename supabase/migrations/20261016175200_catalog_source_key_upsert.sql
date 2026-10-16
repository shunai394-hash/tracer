alter table public.tc_products add column if not exists source_key text;
create unique index if not exists tc_products_source_key_uidx on public.tc_products(source_key);
