# TRACER commerce architecture audit

Baseline: main at 8a02ac33e5482b2e8b7d5f495f635b58e4292bb1
Audit date: 2026-10-11
Safety: read-only audit only. No production writes, channel sync, order placement, or deletion.

## Production baseline

Supabase project lysavahpadzrhpounjgi:

| Table | Rows | Finding |
|---|---:|---|
| products | 1,525 | Canonical product table with many downstream foreign keys |
| product_identifiers | 296 | Identifier evidence corpus |
| product_offers | 1,128 | Market offer observations |
| supplier_listings | 57,063 | Candidate supplier corpus; predominantly unverified/unknown |
| shop_listings | 767 | Latest aggregate: all blocked and unpublished |
| shop_orders / shop_order_items | 0 / 0 | No persisted customer orders at audit time |
| purchase_orders / supplier_order_attempts | 0 / 0 | No persisted supplier POs or attempts at audit time |
| internal_supply_products / internal_supply_variants | 60 / 60 | Internal supply catalog exists |
| internal_supply_links | 0 | No marketplace-to-internal-supply links |
| marketplace_bestseller_variants | 0 | Table exists, no evidence rows |
| internal_supply_ingestion_audit | 0 | Table exists, no audit rows |
| tracer_supply_catalog / tracer_supply_variants | 14 / 0 | Catalog has no variant rows |
| cron_runs | 2,745 | Operational history must be preserved |

The latest aggregate had 540 listings with a BASE item ID and 614 with a Shopify product ID. Preserve these identifiers; they do not prove current authentication or eligibility.

## Existing modules

- Shopify transport/auth: lib/shopify/admin.ts (token exchange, cached token, GraphQL transport).
- Shopify listing orchestration: lib/shopify/sync-published-listings.ts (database selection, catalog checks and Shopify writes).
- BASE listing orchestration: lib/channels/base-publisher.ts (database access, gate checks and BASE writes).
- BASE order import: lib/channels/base-orders.ts (imports orders and invokes dropship PO-intent creation).
- Dropship PO intent/gate: lib/ordering/dropship.ts (payment check, order/listing reads and PO-intent creation).
- Supplier execution: lib/procurement/order.ts plus lib/ordering/verified-supplier-execution.ts and supplier adapters.
- app/api/cron/dropship-execution/route.ts imports BASE orders and then runs autonomous supplier-order control.
- app/api/cron/base-orders/route.ts independently invokes the same BASE order import. Both routes are scheduled in vercel.json, so ownership and idempotency need proof before schedule consolidation.
- app/api/admin/shopify/readiness/route.ts is diagnostic only; it is not proof of successful Shopify Admin API authentication.

## Structural findings

1. Discovery is not canonical identity. The 57,063 supplier candidates coexist with only 296 product identifier records, zero internal supply links, and zero marketplace variant evidence rows. Separate candidate ingestion from evidence-backed product/variant linking.
2. shop_listings is overloaded: channel IDs, supplier IDs, copy, economics, inventory, gate decisions, publication leases and sync errors live together. Extract pure policy evaluation first; do not rewrite rows or external IDs.
3. Channel publishers combine DB selection, catalog quality checks, policy decisions, API writes and status updates. Separate transport adapters from shared channel-neutral policy.
4. Order import, PO intent and supplier execution are distinct operations. Preserve paid-order checks, idempotency, kill switch, supplier variant requirements and the explicit execution boundary.
5. Scheduled routes have overlapping responsibility: dropship-execution calls BASE order import while base-orders is also scheduled. Prove deduplication before changing production schedules.
6. The variant evidence and ingestion audit tables are empty. Table existence must not be mistaken for a functioning evidence pipeline.

## Target boundaries

- connectors: BASE, Shopify and supplier HTTP/auth only; typed responses.
- catalog: canonical product identity, canonical variant identity, supplier offer evidence.
- policy: pure deterministic publication gate and order gate.
- workflows: supply discovery, identity reconciliation, channel publication, order import and procurement execution.
- adapters: retain existing API implementations initially; external IDs remain unchanged.

## Safe migration sequence

1. Add characterization tests for ambiguous identifiers, variant mismatch, stale inventory, Japanese catalog copy, payment/COD, idempotency and kill switch.
2. Extract pure policy functions without changing DB access or outcomes. Compare old/new decisions on a fixed read-only sample.
3. Add typed channel and supplier adapter interfaces while retaining current implementations.
4. Build canonical variant evidence and ingestion audit with duplicate/ambiguous-ID tests; never link by title alone.
5. Separate order import, PO intent and supplier execution. Test with fixtures/dry-run; import must not itself trigger supplier writes.
6. Verify Shopify read-only auth independently: HTTP 200, no GraphQL errors, expected shop ID.
7. Shadow-compare with all writes disabled; promote one channel at a time only after parity.
8. Consider schedule consolidation only after explicit idempotency verification.

## Acceptance criteria

- Product, supplier, BASE item, Shopify product/variant, order and audit IDs are preserved.
- Ambiguous identity never auto-links.
- Publication requires verified identity, exact supplier variant, positive confirmed stock, orderability, tracking, valid Japanese title/description/image and positive margin after costs.
- Unpaid, pending and COD orders cannot trigger supplier procurement.
- Retries are idempotent; kill switch and dry-run are enforced at execution.
- Shopify read-only auth returns HTTP 200 with expected shop ID; readiness-only output does not count.
- Tests and shadow comparison pass before enabling production writes.
