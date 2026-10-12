-- A retried Shopify webhook must be able to upsert each line item safely.
-- Fail migration if earlier partial saves already created duplicate identities;
-- those rows require explicit reconciliation rather than silent deletion.
do $$
begin
  if exists (
    select 1
    from public.shop_order_items
    where shopify_line_item_id is not null
    group by order_id, shopify_line_item_id
    having count(*) > 1
  ) then
    raise exception 'shop_order_items contains duplicate (order_id, shopify_line_item_id) identities; reconcile duplicates before applying Shopify idempotency index';
  end if;
end $$;

create unique index if not exists shop_order_items_shopify_line_item_unique
  on public.shop_order_items(order_id, shopify_line_item_id);
