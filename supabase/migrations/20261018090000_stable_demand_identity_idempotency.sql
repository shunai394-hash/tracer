-- Treat recreated marketplace rows as idempotent when their stable source identity is unchanged.
-- Keep ledger reads and transition serialization inside the SECURITY DEFINER RPC.
create or replace function public.record_tracer_v2_pipeline_event(
  p_product_key text,
  p_stage text,
  p_outcome text,
  p_idempotency_key text,
  p_external_id text default null,
  p_reason text default null,
  p_evidence jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  existing public.tracer_v2_pipeline_events%rowtype;
  latest_stage text;
  expected_stage text;
  stage_order integer;
  expected_order integer;
  inserted public.tracer_v2_pipeline_events%rowtype;
begin
  if nullif(trim(p_product_key), '') is null or nullif(trim(p_idempotency_key), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'product_key_and_idempotency_key_required');
  end if;

  if p_stage not in (
    'demand_discovered','variant_evidence_saved','supplier_matched','profitability_checked',
    'base_published','shopify_published','newfind_synced','order_received',
    'supplier_order_placed','tracking_synced'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_stage');
  end if;

  if p_outcome not in ('completed', 'blocked', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'unknown_outcome');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_product_key, 0));

  select * into existing
    from public.tracer_v2_pipeline_events
   where product_key = p_product_key and idempotency_key = p_idempotency_key;

  if found then
    if existing.stage = p_stage
       and existing.outcome = p_outcome
       and existing.external_id is not distinct from p_external_id then
      return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', existing.id);
    end if;

    -- The marketplace row UUID may change after a row is recreated. The stable
    -- sourceItemKey is the actual demand identity; only this exact demand replay
    -- may ignore the changed external row UUID. All other mismatches still fail closed.
    if existing.stage = 'demand_discovered'
       and existing.outcome = 'completed'
       and p_stage = 'demand_discovered'
       and p_outcome = 'completed'
       and nullif(existing.evidence->>'sourceItemKey', '') is not null
       and existing.evidence->>'sourceItemKey' = p_evidence->>'sourceItemKey' then
      return jsonb_build_object('ok', true, 'duplicate', true, 'event_id', existing.id);
    end if;

    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_reused_with_different_result');
  end if;

  if p_outcome = 'completed' then
    if p_stage = 'supplier_matched'
       and (nullif(p_evidence->>'supplierProductId', '') is null
         or nullif(p_evidence->>'supplierVariantId', '') is null) then
      return jsonb_build_object('ok', false, 'reason', 'supplier_product_and_variant_ids_required');
    end if;
    if p_stage = 'profitability_checked'
       and coalesce((p_evidence->>'contributionProfit')::numeric, 0) <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'positive_verified_contribution_profit_required');
    end if;
    if p_stage = 'supplier_order_placed' and nullif(trim(p_external_id), '') is null then
      return jsonb_build_object('ok', false, 'reason', 'supplier_order_id_required');
    end if;
    if p_stage = 'tracking_synced' and nullif(trim(p_external_id), '') is null then
      return jsonb_build_object('ok', false, 'reason', 'tracking_number_required');
    end if;

    select stage into latest_stage
      from public.tracer_v2_pipeline_events
     where product_key = p_product_key and outcome = 'completed'
     order by case stage
       when 'demand_discovered' then 1 when 'variant_evidence_saved' then 2
       when 'supplier_matched' then 3 when 'profitability_checked' then 4
       when 'base_published' then 5 when 'shopify_published' then 6
       when 'newfind_synced' then 7 when 'order_received' then 8
       when 'supplier_order_placed' then 9 when 'tracking_synced' then 10
       else 0 end desc, created_at desc
     limit 1;

    stage_order := case p_stage
       when 'demand_discovered' then 1 when 'variant_evidence_saved' then 2
       when 'supplier_matched' then 3 when 'profitability_checked' then 4
       when 'base_published' then 5 when 'shopify_published' then 6
       when 'newfind_synced' then 7 when 'order_received' then 8
       when 'supplier_order_placed' then 9 when 'tracking_synced' then 10
       else 0 end;
    expected_order := case latest_stage
       when 'demand_discovered' then 2 when 'variant_evidence_saved' then 3
       when 'supplier_matched' then 4 when 'profitability_checked' then 5
       when 'base_published' then 6 when 'shopify_published' then 7
       when 'newfind_synced' then 8 when 'order_received' then 9
       when 'supplier_order_placed' then 10
       when 'tracking_synced' then 11 else 1 end;
    if stage_order <> expected_order then
      expected_stage := case expected_order
       when 1 then 'demand_discovered' when 2 then 'variant_evidence_saved'
       when 3 then 'supplier_matched' when 4 then 'profitability_checked'
       when 5 then 'base_published' when 6 then 'shopify_published'
       when 7 then 'newfind_synced' when 8 then 'order_received'
       when 9 then 'supplier_order_placed' when 10 then 'tracking_synced'
       else 'pipeline_complete' end;
      return jsonb_build_object('ok', false, 'reason',
        'out_of_order_stage:expected=' || expected_stage || ':received=' || p_stage);
    end if;
  end if;

  insert into public.tracer_v2_pipeline_events
    (product_key, stage, outcome, idempotency_key, external_id, reason, evidence)
  values
    (p_product_key, p_stage, p_outcome, p_idempotency_key, p_external_id, p_reason, coalesce(p_evidence, '{}'::jsonb))
  returning * into inserted;

  return jsonb_build_object('ok', true, 'duplicate', false, 'event_id', inserted.id);
end;
$function$;
