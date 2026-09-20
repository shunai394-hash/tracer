alter table public.products
add column if not exists identity_key text;

create unique index if not exists products_identity_key_key
  on public.products(identity_key)
  where identity_key is not null;

create index if not exists products_identity_key_idx
  on public.products(identity_key);
