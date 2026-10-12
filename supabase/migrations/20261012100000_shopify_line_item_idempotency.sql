-- Shopify line-item IDs are globally unique and are the idempotency key for
-- repairing duplicate webhook deliveries. Refuse to silently choose a row if
-- historical data already contains duplicates; require explicit reconciliation.
do $$
begin
  if exists (
    select 1
    from public.shop_order_items
    where shopify_line_item_id is not null
    group by shopify_line_item_id
    having count(*) > 1
  ) then
    raise exception 'duplicate_shopify_line_item_ids_require_manual_reconciliation';
  end if;
end
$$;

create unique index if not exists shop_order_items_shopify_line_item_unique_idx
  on public.shop_order_items(shopify_line_item_id)
  where shopify_line_item_id is not null;
