-- Enforce idempotency for imported Shopify order lines without touching
-- historical rows that have no Shopify line-item identity.
-- Scope uniqueness to an order so legacy or externally-created IDs cannot
-- collide across orders.
create unique index if not exists shop_order_items_shopify_order_line_uidx
  on public.shop_order_items(order_id, shopify_line_item_id)
  where shopify_line_item_id is not null;

comment on column public.shop_order_items.shopify_line_item_id is
  'Shopify line-item GID used for idempotent import and reconciliation.';
