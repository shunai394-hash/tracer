-- The paid-order sync and orders webhook reconcile individual Shopify lines
-- by Shopify's immutable line-item ID. Add the nullable column without rewriting
-- legacy rows; legacy rows without IDs are handled fail-closed by reconciliation.
alter table public.shop_order_items
  add column if not exists shopify_line_item_id text;

-- Enforce idempotency for Shopify line items during concurrent webhook delivery.
-- Preflight duplicate rows before creating the unique index. If legacy duplicates
-- exist, fail the migration with an actionable error rather than deleting data.
do $
begin
  if exists (
    select 1
    from public.shop_order_items
    where shopify_line_item_id is not null
    group by order_id, shopify_line_item_id
    having count(*) > 1
  ) then
    raise exception 'shopify_line_item_idempotency_preflight_failed: duplicate (order_id, shopify_line_item_id) rows exist; reconcile them before retrying this migration';
  end if;
end
$$;

create unique index if not exists shop_order_items_order_shopify_line_unique_idx
  on public.shop_order_items(order_id, shopify_line_item_id);
