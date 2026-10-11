# TRACER scheduled job side-effect audit (2026-10-11)

## Scope and safety boundary

- Base: `main` at the current branch point; audit branch only.
- This is a static source review of `vercel.json` and scheduled route handlers. It is **not** proof of production runtime state, credentials, or recent execution.
- No production deployment, DB mutation, listing publication/unpublication, purchase order, or Shopify/BASE API write was initiated by this audit.
- The presence of a Cron entry means Vercel can invoke the route on schedule. `requireAutomationAuth` is an authentication gate, not a global write-disable gate. If production auth succeeds, handlers may still perform their coded side effects.
- Schedules are expressed in UTC. In Japan, 12:xx UTC corresponds to 21:xx JST; 18:xx UTC corresponds to 03:xx JST the following day.

## Scheduled route inventory

| Route | Schedule (UTC) | Static classification | Side effects / concern |
|---|---:|---|---|
| `/api/cron/market-sourcing` | 12:00 | DB write; external sourcing may be read | Persists observations and run state. Confirm source integrations and every write path. |
| `/api/cron/supplier-investigation` | 12:05 | DB write | Reads supplier candidates and synchronizes internal catalog; updates run/candidate state. |
| `/api/cron/cj-variant-repair` | 12:07, 18:07 | DB write; supplier API access to verify | Variant repair/reverification handler; inspect helper-level API behavior before allowing automation. |
| `/api/cron/cj-identity-reverify` | 12:09, 18:09 | DB write; supplier API access to verify | Rechecks canonical supplier identity and persists verification results. |
| `/api/cron/orosy-bulk-import` | 12:10, 18:10 | DB write + Shopify external write | Imports supplier data, inserts/updates products and listings, then calls Shopify sync for accepted items. **Not read-only.** |
| `/api/cron/sales-test-publication` | 12:11, 18:11 | DB write + BASE/Shopify external writes | Runs sales-test selection and can publish selected listings to Shopify and BASE. **Publication-capable.** |
| `/api/cron/shopify-publish` | 12:14, 18:14 | Shopify external write | Calls published-listing sync. **Publication-capable.** |
| `/api/cron/inventory-refresh` | 12:15 | DB write + BASE external write | Changes orderable/published state and calls BASE item editing. May unpublish/update listings. |
| `/api/cron/demand-match` | 12:17, 18:17, 18:52 | DB write | Writes demand-match and run results; confirm it cannot indirectly enqueue publishing. |
| `/api/cron/intelligence` | 12:22, 18:22, 18:57 | DB write + Shopify external write | Builds intelligence, selects supply sales tests, and can sync selected listings to Shopify. **Publication-capable.** |
| `/api/cron/base-orders` | 12:25 | BASE read + DB write | Imports BASE orders into TRACER; verify deduplication/idempotency and state transitions. |
| `/api/cron/dropship-execution` | 12:30 | BASE read + DB write + supplier purchase write | Imports BASE orders and invokes autonomous order control. **Potential supplier order placement.** |
| `/api/cron/shopify-orders` | 12:33 | Shopify read + DB write + potential supplier purchase write | Imports paid Shopify orders and may invoke autonomous order control. |
| `/api/cron/supplier-reconciliation` | 12:35 | Supplier API read + DB write (verify helpers) | Reconciles supplier orders and persists results; verify whether any helper can mutate supplier orders. |
| `/api/cron/shopify-fulfillment` | 12:38 | Shopify read + Shopify external write + DB write | Helper contains a `FulfillmentCreate` GraphQL mutation as well as a query. **Potential fulfillment/tracking write**, not read-only. Verify its gates and eligibility before allowing automation. |
| `/api/cron/supplier-orders` | 12:40 | Supplier API read + DB write (confirmed from helper) | `lib/procurement/sync-orders.ts` queries supplier status/tracking and updates `purchase_orders` metadata/status. No create-order call was seen in this helper, but adapter transitive behavior still needs confirmation. |
| `/api/cron/newfind-retry` | 12:45 | DB write + NEWFIND external writes | Retries/promotes and may withdraw NEWFIND promotions. External state changes possible. |
| `/api/cron/supply-first` | 12:50 | Supplier discovery + DB write; downstream pipeline | Discovers CJ supply, persists verified candidates, then can build intelligence. Inspect indirect publication path. |
| `/api/cron/patrol-ai` | 12:55, 18:59 | DB write + BASE/NEWFIND external writes; downstream pipeline | Runs full intelligence pipeline, publishes to BASE, and attempts NEWFIND recovery. **Not a passive monitoring-only patrol.** |

## Additional route names found, not present in the current `vercel.json` Cron list

The source tree also contains `/api/cron/ai-patrol`, `base-publish`, `core-engine`, `demand`, `superdelivery-sales-route`, and `unpublish-unlinked`. Their existence alone does not establish they are scheduled; inspect Vercel deployment configuration and any external schedulers before concluding they are inactive.

## Transitive helper checks (first pass)

- `lib/ordering/autonomous-control.ts` creates dropship purchase orders for eligible shop orders and calls `executeVerifiedSupplierPurchaseOrder`. This is a real supplier-order execution path, not merely a recommendation pipeline.
- `lib/channels/base-orders.ts` imports BASE order details and writes internal order state; it also calls `createDropshipPurchaseOrdersForShopOrder`, so the BASE order import itself can create internal purchase-order records even before the separately scheduled dropship executor runs.
- `lib/shopify/sync-orders.ts` queries paid Shopify orders and inserts `shop_orders` / `shop_order_items`, with cleanup deletes on partial insert failure. This is a DB write path and must be idempotent under retries.
- `lib/shopify/sync-fulfillments.ts` contains a `FulfillmentCreate` mutation. The route can write to Shopify, so it must not be treated as read-only fulfillment polling.
- `lib/shopify/sync-published-listings.ts` calls product create/update, publish, inventory and unpublish helpers and may update `shop_listings` copy/sync fields. It is an external write path in both directions (publish and unpublish).
- `lib/channels/base-publisher.ts` can call BASE product publication/update APIs and updates local listing state; it also has a path that marks listings blocked when supplier identity is unlinked. Confirm the full external hide/unpublish branch separately.
- `lib/procurement/sync-orders.ts` fetches supplier order status/tracking and updates purchase-order records. No supplier order creation was visible in that helper itself, but registered adapters should be inspected to confirm their status methods are read-only.

## Initial findings

1. The schedule includes multiple independently publication-capable routes. A single failed auth diagnostic does not disable them; each route may still run if its own automation authentication succeeds.
2. Order automation is separately scheduled from channel order ingestion. `dropship-execution` and `shopify-orders` both invoke autonomous order control, so duplicate-order/idempotency controls need tests across both entry points, not only within one route.
3. `patrol-ai` is not just observability: it invokes intelligence, BASE publication, and NEWFIND recovery.
4. `orosy-bulk-import` is not just catalog ingestion: its tail calls Shopify synchronization.
5. Publication logic exists in more than one route (`sales-test-publication`, `shopify-publish`, `intelligence`, `patrol-ai`, and `orosy-bulk-import`). The new design should funnel these through one explicit publication command guarded by a shared fail-closed gate.
6. Static inspection cannot establish whether current production Cron jobs are actually enabled/executing, nor prove no writes are occurring. Verify deployment Cron configuration, recent invocation logs, and external scheduler configuration read-only.

## Required next steps (no production changes yet)

1. Continue the transitive call graph through registered supplier adapters, `executeVerifiedSupplierPurchaseOrder`, `lib/ordering/dropship.ts`, `lib/shopify/admin.ts`, and the BASE hide/unpublish branch. The first pass has already confirmed Shopify fulfillment mutation and autonomous supplier order execution.
2. Read-only inspect deployment Cron configuration and recent logs; do not infer runtime status from `vercel.json` alone.
3. Define one global fail-closed automation mode with explicit capabilities (read-only diagnostics, DB writes, channel publication, supplier purchase). Implement only in a separate branch and test that disabled capabilities block all indirect call paths.
4. Add idempotency tests across BASE and Shopify order ingestion and supplier execution, plus integration tests for publication gates.
5. Keep this branch isolated. Do not merge, deploy, or run a write-capable Cron until the side-effect matrix and tests are reviewed.

## Evidence source

- `vercel.json` on `main`
- Static source of each route listed above on `main`
- Review date: 2026-10-11


## Follow-up verification rounds (2026-10-11)

### Order ingestion and procurement

- Shopify order-level race: importer now re-reads the winning `shop_orders.shopify_order_id` row after unique-constraint error `23505`, then records a skip rather than a duplicate failure.
- Shopify order-line identity: importer now persists `shopify_line_item_id = item.id`; a new partial unique index on non-null Shopify line-item IDs prevents one external line from being imported under multiple local orders. Existing rows with a null line-item ID are not affected.
- A dedicated PostgreSQL integration test runs only in the disposable CI database. It checks duplicate external line IDs are rejected across orders and that legacy null IDs remain allowed.
- Order recovery: autonomous control now selects paid `fulfillment_pending` orders in addition to `placed` and `processing`. This matches the status written by Shopify order ingestion.
- Existing supplier-attempt ledger has a unique idempotency key and unique purchase-order constraint. Concurrent attempt claims fail closed; ambiguous external outcomes move to `unknown` and require manual reconciliation rather than an automatic repeat.
- Existing dropship PO creation uses stable `dropship:<shop_order_item_id>` keys and handles unique-constraint races by re-reading the winning PO.

### Remaining limits

- These are source-level checks and disposable-CI tests, not a production database duplicate scan. Before applying the new migration to production, run a read-only duplicate preflight for non-null `shopify_line_item_id` values and verify the column/index state.
- The order automation run row is telemetry/idempotency support, not a proven distributed lease. Concurrent runs may both inspect the same paid order; PO and supplier-attempt uniqueness are the downstream protections. A dedicated claim/lease integration test remains desirable.
- A supplier attempt left in `in_progress` deliberately blocks another external order attempt. This favors no-duplicate safety over automatic recovery; stale attempts require reconciliation until a reviewed lease/recovery policy exists.
- No production credentials, Cron settings, database rows, channel listings, customer fulfillment, or supplier orders were changed during these checks.


## Ten-pass self-audit record

1. **Fail-closed policy:** missing/invalid mode, disabled mode, and global stop deny capability; covered by CI policy tests.
2. **Scheduled route inventory:** all 19 unique routes from `vercel.json` have a declared capability and route-level guard.
3. **Non-Cron write endpoints:** eight additional write-capable endpoints are mapped and checked by CI.
4. **Workflow admission:** eight production-write workflows are manual-only and require `allow_production_writes=true`; CI checks their trigger and job guards.
5. **Shopify order race:** order-level unique-constraint recovery re-reads the winner; it does not attempt a second parent insert.
6. **Shopify line identity:** stable line-item IDs are persisted and globally unique when non-null; a code-level regression test covers the mapping.
7. **Database constraint:** a disposable-PostgreSQL test checks duplicate IDs fail and null legacy IDs remain valid. No production migration was run.
8. **Fulfillment recovery:** paid `fulfillment_pending` orders are eligible for recovery, while unpaid and cancelled/refunded orders remain blocked by the dropship gate; static regression checks cover the conditions.
9. **Cross-entry idempotency:** BASE item repair uses `base_order_item_key`; dropship POs use stable per-item keys; supplier attempts have unique keys and fail closed on ambiguous/in-progress states. Remaining stale-attempt recovery is documented rather than guessed.
10. **Runtime/build and deployment boundary:** CI on commit `9d8a7cac352e6f4d60120fa5eacb15b1c3d78445` passed, including TypeScript, lint, build and the new disposable DB test. A further docs-only commit is undergoing its own CI run. Read-only Vercel inspection confirms the linked project domain is `tracer-pied-alpha.vercel.app`; the branch deployments observed have `target=null` (preview), not production.

**Exit criteria:** keep PR #234 Draft until CI on the final head is green, the production database is read-only checked for duplicate non-null Shopify line IDs before migration, and the production environment/cron transition is reviewed. No production writes or merge are authorized by this audit.


## Follow-up audit — 2026-10-11

### Additional fixes on the draft branch
- Shopify order ingestion now walks the paid-order connection until it has enough not-yet-imported candidates, rather than repeatedly querying only the same first page. It scans newest-first and records the number of orders examined.
- Both order-level and nested line-item pagination fail closed if Shopify claims another page but does not advance its cursor.
- Nested line-item pages are fully retrieved before any local order insert. Duplicate line-item GIDs within the fetched order are rejected.
- The line-item migration now adds `shopify_line_item_id text` if the column is absent before creating the partial unique index. The disposable PostgreSQL test now starts with a table lacking that column so the migration itself must create it.
- Autonomous order runs now require a durable unique-key claim. Existing running/failed claims, claim lookup/insert failures, unique-key races, and finalization failures stop processing. Completed run keys return idempotently; ambiguous runs require reconciliation and a new key.
- The Shopify order route uses a minute-scoped run key rather than an hour-scoped key to reduce delay before newly imported orders are picked up.

### Validation boundary
- Final-head CI must be green on the latest PR head; earlier heads have failed TypeScript during the order-pagination refactor and were corrected with explicit response/cursor types.
- The connected Supabase read-only check found `shop_order_items` exists with zero rows and does not yet have `shopify_line_item_id`. This observation is for the connected project only; production target equivalence is not independently established.
- No production migration, publication, supplier order, or production deployment was initiated by this audit.
