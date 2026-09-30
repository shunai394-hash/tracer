-- Keep the inventory reservation RPC contract aligned with the adapter.
-- The adapter consumes remaining_inventory/restored_inventory explicitly.
-- Drop/recreate is required because PostgreSQL cannot change OUT parameter
-- names with CREATE OR REPLACE FUNCTION.
drop function if exists public.reserve_internal_supply_variant(uuid, integer);
drop function if exists public.release_internal_supply_variant(uuid, integer);

create function public.reserve_internal_supply_variant(
  p_variant_id uuid,
  p_quantity integer
)
returns table(variant_id uuid, remaining_inventory integer)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive';
  end if;

  return query
  update public.internal_supply_variants
     set inventory = inventory - p_quantity,
         orderable = (inventory - p_quantity) > 0,
         updated_at = now()
   where id = p_variant_id
     and active = true
     and orderable = true
     and inventory is not null
     and inventory >= p_quantity
  returning id, inventory;
end;
$$;

create function public.release_internal_supply_variant(
  p_variant_id uuid,
  p_quantity integer
)
returns table(variant_id uuid, restored_inventory integer)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity_must_be_positive';
  end if;

  return query
  update public.internal_supply_variants
     set inventory = coalesce(inventory, 0) + p_quantity,
         orderable = true,
         updated_at = now()
   where id = p_variant_id
     and active = true
  returning id, inventory;
end;
$$;

revoke all on function public.reserve_internal_supply_variant(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_internal_supply_variant(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_internal_supply_variant(uuid, integer) to service_role;
grant execute on function public.release_internal_supply_variant(uuid, integer) to service_role;
