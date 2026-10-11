-- Enforce idempotency for imported Shopify order lines without touching
-- historical rows that have no Shopify line-item identity.
-- Shopify line-item GIDs are stable external identities; prevent the same
-- line from being imported under multiple local orders.
create unique index if not exists shop_order_items_shopify_line_item_id_uidx
  on public.shop_order_items(shopify_line_item_id)
  where shopify_line_item_id is not null;

comment on column public.shop_order_items.shopify_line_item_id is
  'Shopify line-item GID used for idempotent import and reconciliation.';
