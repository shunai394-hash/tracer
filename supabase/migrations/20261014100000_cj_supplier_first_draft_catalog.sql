-- Supplier-first draft projection: no marketplace/bestseller dependency.
-- This RPC can only stage a non-orderable draft. It intentionally cannot publish
-- or mark a supplier variant orderable; live procurement capability is separate.
create or replace function public.stage_cj_supplier_first_catalog_draft(
  p_product_id uuid,
  p_variant_id uuid,
  p_expected_product_generation bigint,
  p_expected_variant_generation bigint
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
  v_tracer_sku text;
  v_variant_sku text;
  v_source_ref text;
  v_supplier_product_id text;
  v_supplier_variant_id text;
  v_barcode text;
begin
  if p_product_id is null or p_variant_id is null
     or p_expected_product_generation is null or p_expected_variant_generation is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_sync_arguments');
  end if;

  select * into v_product from public.internal_supply_products
   where id = p_product_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'product_missing'); end if;

  select * into v_variant from public.internal_supply_variants
   where id = p_variant_id and supply_product_id = p_product_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'variant_missing_or_wrong_owner'); end if;

  if v_product.generation is distinct from p_expected_product_generation
     or v_variant.generation is distinct from p_expected_variant_generation then
    return jsonb_build_object('ok', false, 'reason', 'generation_conflict');
  end if;

  if v_product.source_name <> 'cj' or v_variant.source_name <> 'cj'
     or v_product.active is distinct from true or v_variant.active is distinct from true then
    return jsonb_build_object('ok', false, 'reason', 'not_active_cj_supply');
  end if;

  -- Only supplier fetch timestamps prove freshness. updated_at may be changed by
  -- our own ingestion/audit writes and must never be used as supplier evidence.
  if v_product.fetched_at is null
     or v_variant.fetched_at is null
     or v_product.fetched_at < now() - interval '24 hours'
     or v_variant.fetched_at < now() - interval '24 hours' then
    return jsonb_build_object('ok', false, 'reason', 'supplier_evidence_stale');
  end if;

  v_supplier_product_id := nullif(btrim(v_product.metadata->>'supplier_product_id'), '');
  v_supplier_variant_id := nullif(btrim(v_variant.metadata->>'supplier_variant_id'), '');
  if v_supplier_product_id is null or v_supplier_variant_id is null
     or v_variant.variant_id is distinct from v_supplier_variant_id
     or v_product.source_ref is distinct from ('cj:' || v_supplier_product_id || ':' || v_supplier_variant_id) then
    return jsonb_build_object('ok', false, 'reason', 'supplier_scoped_identity_mismatch');
  end if;

  -- This projection is deliberately a draft, even when stock/cost data is fresh.
  -- Missing/invalid global barcode is acceptable only because the identity key is
  -- the exact CJ product+variant pair; it is never represented as global identity.
  v_source_ref := 'cj:' || v_supplier_product_id || ':' || v_supplier_variant_id;
  v_tracer_sku := 'TRC-CJ-' || replace(p_product_id::text, '-', '');
  v_variant_sku := 'TRC-CJV-' || replace(p_variant_id::text, '-', '');
  -- Supplier identifiers are retained in the source attributes, but this draft
  -- projection has not independently verified a global barcode. Do not promote
  -- any supplied identifier into the canonical barcode column.
  v_barcode := null;

  insert into public.tracer_supply_catalog (
    tracer_sku,title,brand,category,image_url,status,cost,shipping_cost,handling_cost,
    sale_price,currency,inventory,lead_time_days,tracking_available,orderable,
    source_type,source_ref,evidence,metadata,bestseller_id,updated_at
  ) values (
    v_tracer_sku, v_variant.title, v_product.brand, null,
    nullif(v_variant.metadata->>'image_url',''), 'draft',
    coalesce(v_variant.cost,v_product.cost), coalesce(v_variant.shipping_cost,v_product.shipping_cost),
    0, null, coalesce(v_variant.currency,v_product.currency,'USD'),
    greatest(0,coalesce(v_variant.inventory,0)), v_product.lead_time_days,
    coalesce(v_variant.tracking_available,false) or coalesce(v_product.tracking_available,false),
    false, 'cj', v_source_ref,
    jsonb_build_object(
      'identity_scope','supplier_variant',
      'supplier','cj',
      'supplier_product_id',v_supplier_product_id,
      'supplier_variant_id',v_supplier_variant_id,
      'global_barcode_verified',false,
      'automated_order_creation_verified',false,
      'demand_evidence_status','not_observed'
    ),
    coalesce(v_variant.metadata,'{}'::jsonb) || jsonb_build_object(
      'catalog_stage','supplier_first_draft',
      'supplier_product_id',v_supplier_product_id,
      'supplier_variant_id',v_supplier_variant_id,
      'automated_order_creation_verified',false,
      'sale_gate_note','Draft only: supplier order creation and demand evidence are not verified.'
    ),
    null, now()
  )
  on conflict (tracer_sku) do update set
    title=excluded.title, brand=excluded.brand, image_url=excluded.image_url,
    status='draft', cost=excluded.cost, shipping_cost=excluded.shipping_cost,
    handling_cost=0, sale_price=null, currency=excluded.currency,
    inventory=excluded.inventory, lead_time_days=excluded.lead_time_days,
    tracking_available=excluded.tracking_available, orderable=false,
    source_type='cj', source_ref=excluded.source_ref,
    evidence=excluded.evidence, metadata=excluded.metadata,
    bestseller_id=null, updated_at=now()
  where public.tracer_supply_catalog.source_ref is not distinct from excluded.source_ref
  returning id into v_catalog_id;

  if v_catalog_id is null then
    return jsonb_build_object('ok', false, 'reason', 'catalog_sku_owned_by_other_source');
  end if;

  insert into public.tracer_supply_variants (
    catalog_id,variant_sku,title,barcode,attributes,cost,inventory,orderable,
    internal_supply_product_id,internal_supply_variant_id,updated_at
  ) values (
    v_catalog_id,v_variant_sku,v_variant.title,v_barcode,
    coalesce(v_variant.metadata,'{}'::jsonb),coalesce(v_variant.cost,v_product.cost),
    greatest(0,coalesce(v_variant.inventory,0)),false,p_product_id,p_variant_id,now()
  )
  on conflict (variant_sku) do update set
    catalog_id=excluded.catalog_id,title=excluded.title,barcode=excluded.barcode,
    attributes=excluded.attributes,cost=excluded.cost,inventory=excluded.inventory,
    orderable=false,internal_supply_product_id=excluded.internal_supply_product_id,
    internal_supply_variant_id=excluded.internal_supply_variant_id,updated_at=now()
  where public.tracer_supply_variants.internal_supply_product_id is not distinct from excluded.internal_supply_product_id
    and public.tracer_supply_variants.internal_supply_variant_id is not distinct from excluded.internal_supply_variant_id
  returning id into v_catalog_variant_id;

  if v_catalog_variant_id is null then
    raise exception 'supplier_variant_sku_owned_by_other_source' using errcode='23505';
  end if;

  return jsonb_build_object('ok',true,'catalog_id',v_catalog_id,
    'catalog_variant_id',v_catalog_variant_id,'orderable',false,'status','draft');
end;
$$;

revoke all on function public.stage_cj_supplier_first_catalog_draft(uuid,uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function public.stage_cj_supplier_first_catalog_draft(uuid,uuid,bigint,bigint) to service_role;
