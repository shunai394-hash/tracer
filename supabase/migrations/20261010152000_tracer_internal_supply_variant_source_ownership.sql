-- Enforce supplier-scoped ownership for opaque variant IDs at the database boundary.
-- The application precheck alone races when two cron runs ingest the same CJ variant
-- under different product rows. This unique key serializes identity ownership per source.
alter table public.internal_supply_variants
  add column if not exists source_name text;

-- Repair/backfill the denormalized source key from its owning product.
update public.internal_supply_variants v
   set source_name = p.source_name
  from public.internal_supply_products p
 where p.id = v.supply_product_id
   and v.source_name is distinct from p.source_name;

do $$
begin
  if exists (
    select 1 from public.internal_supply_variants
     where source_name is null
  ) then
    raise exception 'cannot enforce supplier variant ownership: some variants have no source_name owner';
  end if;
  if exists (
    select 1
      from public.internal_supply_variants
     where variant_id is not null and btrim(variant_id) <> ''
     group by source_name, variant_id
    having count(*) > 1
  ) then
    raise exception 'cannot enforce supplier variant ownership: duplicate source_name + variant_id pairs require manual reconciliation';
  end if;
end $$;

alter table public.internal_supply_variants
  alter column source_name set not null;

create unique index if not exists internal_supply_variants_source_name_variant_id_uq
  on public.internal_supply_variants(source_name, variant_id)
  where variant_id is not null and btrim(variant_id) <> '';

create or replace function public.set_internal_supply_variant_source_name()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_source_name text;
begin
  select source_name into v_source_name
    from public.internal_supply_products
   where id = new.supply_product_id;
  if not found or v_source_name is null then
    raise exception 'internal supply variant must reference a product with source_name';
  end if;
  new.source_name := v_source_name;
  return new;
end;
$$;

drop trigger if exists internal_supply_variants_set_source_name on public.internal_supply_variants;
create trigger internal_supply_variants_set_source_name
before insert or update of supply_product_id, source_name
on public.internal_supply_variants
for each row execute function public.set_internal_supply_variant_source_name();
