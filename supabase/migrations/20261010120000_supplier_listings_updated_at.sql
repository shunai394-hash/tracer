-- Keep supplier_listings aligned with runtime writes and operational recency queries.
-- Existing rows use fetched_at / created_at as the best available initial timestamp.
alter table public.supplier_listings
  add column if not exists updated_at timestamptz;

update public.supplier_listings
set updated_at = coalesce(fetched_at, created_at, now())
where updated_at is null;

alter table public.supplier_listings
  alter column updated_at set default now(),
  alter column updated_at set not null;

create or replace function public.set_supplier_listings_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists supplier_listings_set_updated_at on public.supplier_listings;
create trigger supplier_listings_set_updated_at
before update on public.supplier_listings
for each row
execute function public.set_supplier_listings_updated_at();
