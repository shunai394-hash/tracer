drop function if exists public.release_internal_supply_variant(uuid, integer);

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
  update public.internal_supply_variants as v
     set inventory = coalesce(v.inventory, 0) + p_quantity,
         orderable = true,
         updated_at = now()
   where v.id = p_variant_id
     and v.active = true
  returning v.id, v.inventory;
end;
$$;

revoke all on function public.release_internal_supply_variant(uuid, integer) from public, anon, authenticated;
grant execute on function public.release_internal_supply_variant(uuid, integer) to service_role;
