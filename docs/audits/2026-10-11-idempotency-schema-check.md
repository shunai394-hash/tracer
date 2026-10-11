# TRACER idempotency schema check — 2026-10-11

Scope: migration source review on `main`, recorded from the isolated branch. This is not a live database query and does not prove every migration is applied in production.

## Confirmed migration-level guards

- `supplier_order_attempts`: unique index on `idempotency_key` and a separate unique index on `purchase_order_id`; state is constrained to `in_progress`, `completed`, or `unknown`. Ambiguous supplier results are intended not to be retried automatically.
- `purchase_order_items`: partial unique index on non-null `idempotency_key`.
- BASE order import: unique index `shop_orders_base_order_key_idx`; a separate migration adds unique `shop_order_items_base_order_item_key_idx` for each BASE order line.
- Internal fulfillment orders: table-level unique constraints on `purchase_order_id` and `order_number`.
- Internal supply source identity: unique index on `internal_supply_products(source_name, source_ref)` when `source_ref` is non-null.
- BASE publication claims and NEWFIND delivery claims have indexes supporting leases, but indexes alone do not prove all competing code paths honor a single shared claim protocol.

## Internal fulfillment side effect

`tracer-internal-adapter.ts` performs a read-before-create on `internal_fulfillment_orders`, checks variant activity/orderability and stock, then calls the `reserve_internal_supply_variant` RPC before creating the fulfillment record. The unique DB constraints and atomic reservation help prevent duplicate orders/overselling, but this is not a no-op: it changes inventory and creates an internal fulfillment order.

## Still unverified

- A live query has not confirmed the production database has all these migrations applied.
- This review has not yet confirmed the unique constraint on `purchase_orders.idempotency_key` itself.
- No concurrent integration test has exercised the BASE and Shopify routes racing on the same logical order item.
- Runtime env values, current Vercel Cron activation, and recent invocation outcomes remain unknown because Vercel team access returned 403.

## Safe next steps

Verify production schema and runtime only through read-only access. If schema access is unavailable, do not infer success from migration files. Add tests for simultaneous BASE/Shopify ingestion, duplicate purchase-order creation, interrupted supplier attempt recovery, and inventory reservation rollback. Keep all changes on `audit/cron-side-effects-20261011`; no production actions.
