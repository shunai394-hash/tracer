-- Generation counters are maintained by PostgreSQL for every UPDATE path.
-- Catalog synchronization rechecks the captured generation under row locks and
-- writes catalog + catalog variant in the same transaction.
alter table public.internal_supply_products
  add column if not exists generation bigint not null default 1;
alter table public.internal_supply_variants
  add column if not exists generation bigint not null default 1;

create or replace function public.bump_internal_supply_generation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.generation := coalesce(old.generation, 0) + 1;
  return new;
end;
$$;

drop trigger if exists internal_supply_products_bump_generation on public.internal_supply_products;
create trigger internal_supply_products_bump_generation
before update on public.internal_supply_products
for each row execute function public.bump_internal_supply_generation();

drop trigger if exists internal_supply_variants_bump_generation on public.internal_supply_variants;
create trigger internal_supply_variants_bump_generation
before update on public.internal_supply_variants
for each row execute function public.bump_internal_supply_generation();

create or replace function public.commit_internal_supply_catalog_sync(
  p_product_id uuid,
  p_variant_id uuid,
  p_expected_product_generation bigint,
  p_expected_variant_generation bigint,
  p_catalog jsonb,
  p_catalog_variant jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.internal_supply_products%rowtype;
  v_variant public.internal_supply_variants%rowtype;
  v_catalog_id uuid;
  v_catalog_variant_id uuid;
begin
  -- Stable lock order across all calls avoids product/variant lock inversion.
  select * into v_product
    from public.internal_supply_products
    where id = p_product_id
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'product_missing');
  end if;

  select * into v_variant
    from public.internal_supply_variants
    where id = p_variant_id and supply_product_id = p_product_id
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'variant_missing_or_wrong_owner');
  end if;

  if v_product.generation <> p_expected_product_generation
     or v_variant.generation <> p_expected_variant_generation then
    return jsonb_build_object(
      'ok', false, 'reason', 'generation_conflict',
      'actual_product_generation', v_product.generation,
      'actual_variant_generation', v_variant.generation
    );
  end if;

  if v_product.active is distinct from true
     or v_variant.active is distinct from true
     or v_variant.orderable is distinct from true
     or coalesce(v_variant.inventory, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'source_not_sellable');
  end if;

  if (p_catalog->>'bestseller_id') is null
     or (p_catalog_variant->>'internal_supply_variant_id')::uuid <> p_variant_id
     or (p_catalog_variant->>'internal_supply_product_id')::uuid <> p_product_id then
    return jsonb_build_object('ok', false, 'reason', 'payload_scope_mismatch');
  end if;

  insert into public.tracer_supply_catalog (
    tracer_sku, title, brand, category, image_url, status, cost, shipping_cost,
    handling_cost, sale_price, currency, inventory, lead_time_days,
    tracking_available, orderable, source_type, source_ref, evidence, metadata,
    bestseller_id, updated_at
  )
  select r.tracer_sku, r.title, r.brand, r.category, r.image_url, r.status,
    r.cost, r.shipping_cost, r.handling_cost, r.sale_price, r.currency,
    r.inventory, r.lead_time_days, r.tracking_available, r.orderable,
    r.source_type, r.source_ref, r.evidence, r.metadata, r.bestseller_id, r.updated_at
  from jsonb_populate_record(null::public.tracer_supply_catalog, p_catalog) as r
  on conflict (tracer_sku) do update set
    title = excluded.title,
    brand = excluded.brand,
    category = excluded.category,
    image_url = excluded.image_url,
    status = excluded.status,
    cost = excluded.cost,
    shipping_cost = excluded.shipping_cost,
    handling_cost = excluded.handling_cost,
    sale_price = excluded.sale_price,
    currency = excluded.currency,
    inventory = excluded.inventory,
    lead_time_days = excluded.lead_time_days,
    tracking_available = excluded.tracking_available,
    orderable = excluded.orderable,
    source_type = excluded.source_type,
    source_ref = excluded.source_ref,
    evidence = excluded.evidence,
    metadata = excluded.metadata,
    bestseller_id = excluded.bestseller_id,
    updated_at = excluded.updated_at
  returning id into v_catalog_id;

  -- Ensure the catalog variant points at the row just committed above.
  p_catalog_variant := jsonb_set(p_catalog_variant, '{catalog_id}', to_jsonb(v_catalog_id::text), true);
  insert into public.tracer_supply_variants (
    catalog_id, variant_sku, title, barcode, attributes, cost, inventory,
    orderable, internal_supply_product_id, internal_supply_variant_id, updated_at
  )
  select r.catalog_id, r.variant_sku, r.title, r.barcode, r.attributes, r.cost,
    r.inventory, r.orderable, r.internal_supply_product_id,
    r.internal_supply_variant_id, r.updated_at
  from jsonb_populate_record(null::public.tracer_supply_variants, p_catalog_variant) as r
  on conflict (variant_sku) do update set
    catalog_id = excluded.catalog_id,
    title = excluded.title,
    barcode = excluded.barcode,
    attributes = excluded.attributes,
    cost = excluded.cost,
    inventory = excluded.inventory,
    orderable = excluded.orderable,
    internal_supply_product_id = excluded.internal_supply_product_id,
    internal_supply_variant_id = excluded.internal_supply_variant_id,
    updated_at = excluded.updated_at
  returning id into v_catalog_variant_id;

  return jsonb_build_object(
    'ok', true,
    'catalog_id', v_catalog_id,
    'catalog_variant_id', v_catalog_variant_id,
    'product_generation', v_product.generation,
    'variant_generation', v_variant.generation
  );
end;
$$;

revoke all on function public.commit_internal_supply_catalog_sync(uuid, uuid, bigint, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_internal_supply_catalog_sync(uuid, uuid, bigint, bigint, jsonb, jsonb) to service_role;
