-- Import a Shopify order and all its line items atomically.
-- A failed line insert rolls back the parent order as part of the same transaction.
create or replace function public.tracer_import_shopify_order_with_items(
  p_order jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_item jsonb;
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception 'shopify_order_payload_invalid';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'shopify_order_items_invalid';
  end if;

  insert into public.shop_orders (
    listing_id, status, payment_method, payment_status, order_status, paid_at,
    customer_name, customer_email, customer_phone, shipping_address,
    shipping_country_code, shipping_province, shipping_city, shipping_zip,
    shipping_line1, subtotal, shipping_cost, total, currency, metadata,
    shopify_order_id, shopify_order_number, shopify_financial_status,
    shopify_fulfillment_status
  ) values (
    nullif(p_order->>'listing_id', '')::uuid,
    p_order->>'status',
    p_order->>'payment_method',
    p_order->>'payment_status',
    p_order->>'order_status',
    nullif(p_order->>'paid_at', '')::timestamptz,
    p_order->>'customer_name',
    p_order->>'customer_email',
    p_order->>'customer_phone',
    p_order->>'shipping_address',
    p_order->>'shipping_country_code',
    p_order->>'shipping_province',
    p_order->>'shipping_city',
    p_order->>'shipping_zip',
    p_order->>'shipping_line1',
    nullif(p_order->>'subtotal', '')::numeric,
    nullif(p_order->>'shipping_cost', '')::numeric,
    nullif(p_order->>'total', '')::numeric,
    p_order->>'currency',
    coalesce(p_order->'metadata', '{}'::jsonb),
    p_order->>'shopify_order_id',
    p_order->>'shopify_order_number',
    p_order->>'shopify_financial_status',
    p_order->>'shopify_fulfillment_status'
  ) returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    insert into public.shop_order_items (
      order_id, listing_id, product_id, supplier_listing_id, supplier_name,
      supplier_product_id, supplier_variant_id, title, qty, unit_price,
      currency, shopify_line_item_id
    ) values (
      v_order_id,
      nullif(v_item->>'listing_id', '')::uuid,
      nullif(v_item->>'product_id', '')::uuid,
      nullif(v_item->>'supplier_listing_id', '')::uuid,
      v_item->>'supplier_name',
      v_item->>'supplier_product_id',
      v_item->>'supplier_variant_id',
      v_item->>'title',
      (v_item->>'qty')::numeric,
      nullif(v_item->>'unit_price', '')::numeric,
      v_item->>'currency',
      v_item->>'shopify_line_item_id'
    );
  end loop;

  return v_order_id;
end;
$$;

revoke all on function public.tracer_import_shopify_order_with_items(jsonb, jsonb) from public;
revoke all on function public.tracer_import_shopify_order_with_items(jsonb, jsonb) from anon;
revoke all on function public.tracer_import_shopify_order_with_items(jsonb, jsonb) from authenticated;
grant execute on function public.tracer_import_shopify_order_with_items(jsonb, jsonb) to service_role;
