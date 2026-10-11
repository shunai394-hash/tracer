# TRACER Cron/order side-effect follow-up — 2026-10-11

Scope: static source inspection only, on `audit/cron-side-effects-20261011`. No production changes or external writes were run.

## Supplier adapter capabilities found in main

- `tracer_internal`: registered; declares live ordering capability. Its order adapter writes internal fulfillment rows in Supabase, so this is a consequential database side effect. It requires `TRACER_INTERNAL_LIVE_ORDERING=1` and the shared order gates.
- `orosy`: registered; `orderCreation=false`, `liveOrdering=false`.
- `faire`: registered; `orderCreation=false`, `liveOrdering=false`; `createOrder` returns `FAIRE_ORDER_CONTRACT_UNVERIFIED`.
- `dsers`: registered; `orderCreation=false`, `liveOrdering=false`; unsupported operations throw `DSERS_MCP_CONTRACT_UNVERIFIED`.
- `TRACER_TEST`: registered; no live order capability and test-only create response.
- CJ/CJDropshipping and SuperDelivery are rejected by the adapter registry.
- `SUPPLIER_DRY_RUN` defaults to enabled unless explicitly set to `0`. Production environment values were not read, so effective production behavior is unconfirmed.

## Cross-route order flow

1. Both `/api/cron/dropship-execution` and `/api/cron/shopify-orders` invoke `runAutonomousOrderControl`.
2. The order controller selects paid orders in `placed`, `processing`, or `fulfilled` states, creates/reuses purchase-order records, and calls the verified execution wrapper.
3. Purchase-order idempotency is based on `dropship:<shop_order_item_id>`, with unique-conflict recovery. Purchase-order items use a separate idempotency key. The DB uniqueness constraints and concurrent cross-route integration tests still need verification.
4. Per-route hourly run keys do not independently deduplicate across the BASE and Shopify entry points; item-level PO idempotency is the primary shared guard.
5. `lib/procurement/sync-orders.ts` reads supplier status/tracking and writes purchase-order and customer-order states; it does not call supplier order creation in the inspected helper.

## Vercel runtime state

The read-only Vercel project inspection returned HTTP 403: the connected Vercel integration lacks access to team scope `team_shunai394-9704s-projects`. No settings were changed. Active Cron state and recent invocation logs remain **unknown**, not stopped. Grant the integration access to that team or use an authorized read-only CLI session, then inspect the active deployment and recent logs.

## Next checks

- Inspect migrations for unique constraints on purchase-order and supplier-attempt idempotency keys.
- Trace all scheduled route call graphs to Shopify/BASE publish, unpublish, fulfillment, and supplier/internal order mutations.
- Add shared fail-closed capability enforcement and cross-route idempotency tests on this branch only.
- Do not merge, deploy, alter production Cron settings, publish/unpublish listings, or create orders as part of this audit.
