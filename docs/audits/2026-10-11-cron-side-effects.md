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
