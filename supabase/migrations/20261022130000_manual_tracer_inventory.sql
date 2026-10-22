-- Allow TRACER-owned stock and storefront publishing without treating a Shopify/CJ link as inventory authority.
alter table public.shop_listings
  add column if not exists manual_inventory boolean not null default false;

create index if not exists shop_listings_manual_published_idx
  on public.shop_listings (published, published_at desc)
  where manual_inventory = true and archived_at is null;

create or replace function public.reserve_manual_listing_stock(p_listing_id uuid, p_quantity integer)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  reserved_id uuid;
begin
  if p_quantity is null or p_quantity < 1 then
    return false;
  end if;
  update public.shop_listings
  set inventory = inventory - p_quantity,
      updated_at = now()
  where id = p_listing_id
    and manual_inventory = true
    and published = true
    and archived_at is null
    and inventory >= p_quantity
  returning id into reserved_id;
  return reserved_id is not null;
end;
$$;

create or replace function public.release_manual_listing_stock(p_listing_id uuid, p_quantity integer)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_quantity is null or p_quantity < 1 then
    return;
  end if;
  update public.shop_listings
  set inventory = inventory + p_quantity,
      updated_at = now()
  where id = p_listing_id
    and manual_inventory = true
    and archived_at is null;
end;
$$;

revoke all on function public.reserve_manual_listing_stock(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_manual_listing_stock(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_manual_listing_stock(uuid, integer) to service_role;
grant execute on function public.release_manual_listing_stock(uuid, integer) to service_role;
