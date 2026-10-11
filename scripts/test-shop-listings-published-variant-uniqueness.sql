-- Disposable CI database only. Verifies published supplier-variant uniqueness.
create table public.shop_listings (
  id bigserial primary key,
  supplier_variant_id text,
  published boolean not null default false
);

-- Historical blocked duplicates must remain representable for safe cleanup.
insert into public.shop_listings (supplier_variant_id, published)
values ('variant-duplicate', false), ('variant-duplicate', false);

\i supabase/migrations/20261011200000_shop_listings_unique_published_supplier_variant.sql
\i supabase/migrations/20261011200000_shop_listings_unique_published_supplier_variant.sql

insert into public.shop_listings (supplier_variant_id, published)
values ('variant-duplicate', true);

do $$
begin
  begin
    insert into public.shop_listings (supplier_variant_id, published)
    values ('variant-duplicate', true);
    raise exception 'expected duplicate published supplier variant to be rejected';
  exception when unique_violation then
    null;
  end;
end
$$;

-- A null supplier variant cannot be compared, so it is excluded from the index.
insert into public.shop_listings (supplier_variant_id, published)
values (null, true), (null, true);

do $$
begin
  if (select count(*) from public.shop_listings where supplier_variant_id = 'variant-duplicate' and published = false) <> 2 then
    raise exception 'historical blocked duplicates were not preserved';
  end if;
  if (select count(*) from public.shop_listings where supplier_variant_id = 'variant-duplicate' and published = true) <> 1 then
    raise exception 'published variant uniqueness failed';
  end if;
end
$$;
