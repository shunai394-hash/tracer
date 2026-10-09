-- Repair schema drift: application code orders and updates supplier_listings.updated_at,
-- but the original table only defined created_at and fetched_at.
alter table public.supplier_listings
  add column if not exists updated_at timestamptz;

update public.supplier_listings
set updated_at = coalesce(updated_at, fetched_at, created_at, now())
where updated_at is null;

alter table public.supplier_listings
  alter column updated_at set default now(),
  alter column updated_at set not null;

create index if not exists supplier_listings_updated_at_idx
  on public.supplier_listings (updated_at desc);

create or replace function public.touch_supplier_listings_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists supplier_listings_touch_updated_at on public.supplier_listings;
create trigger supplier_listings_touch_updated_at
before update on public.supplier_listings
for each row execute function public.touch_supplier_listings_updated_at();

grant all privileges on table public.supplier_listings to service_role;
