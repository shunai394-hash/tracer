# TRACER commerce-core separation plan

## Safety boundary

This branch is an isolated refactor foundation. It does not change the production cron schedule, database schema, deployed route definitions, or external IDs. One intentional fail-closed policy change is included: the existing sales-test gate now rejects an unknown contribution profit. That can only remove eligibility, not make a blocked listing eligible. No production data writes or external channel calls were made during this work. Do not merge or enable new write paths until the acceptance checks below pass.

## Audit snapshot (2026-10-11)

- Production deployment is READY at commit `c16d9162d547bb8bf034b1e134c3ea174a5cca7b` (2026-10-11); deployment status is separate from provider readiness.
- The protected production read-only Shopify probe at `2026-10-11T05:08:44Z` returned HTTP 200, the expected shop `ieufrg-tb.myshopify.com` / shop ID `gid://shopify/Shop/74624434220`, no GraphQL errors, and a successful client-credentials exchange. Two required fulfillment scopes remain missing: `read_merchant_managed_fulfillment_orders` and `write_merchant_managed_fulfillment_orders`.
- The protected production BASE probe returned HTTP 200 for the read-only order-list request and zero orders. This proves the current token can read the list endpoint; it does not prove order ingestion or purchasing works end to end.
- The read-only identity audit scanned 767 listings: 669 have a supplier-listing FK and matching external product/variant IDs on the same internal product, but all 669 referenced supplier rows remain `identity_status=supply_discovered` (534 `verified`, 135 `retryable`). There are 98 listings missing external product/variant identity, 451 referenced supplier rows with verification errors, and zero linked/repairable canonical identity matches. No rows were modified.
- `vercel.json` contains scheduled routes for discovery, supplier investigation, variant repair, sales-test publication, Shopify publication, inventory refresh, BASE orders, dropship execution, Shopify orders, supplier reconciliation, fulfillment, supplier orders, and `patrol-ai`. This means production writes may be triggered by scheduled routes independently of a manual diagnostic.
- `app/api/cron/dropship-execution/route.ts` combines BASE order sync and autonomous supplier-order control in one route. Separate these responsibilities behind explicit stages and durable idempotency.
- `lib/channels/base-publisher.ts` combines catalog copy validation, identity checks, database state changes, BASE visibility changes, and remote item creation/editing. Split policy evaluation from the external adapter and persistence/reconciliation.
- `app/api/cron/shopify-publish/route.ts` invokes synchronization directly after its automation auth/config checks. A future write executor must additionally require a recorded passing preflight and explicit mode.
- Confirmed TRACER Supabase project: `lysavahpadzrhpounjgi` (Tokyo). Read-only schema/data audit observed products=1,525; supplier_listings=57,063; shop_listings=767; shop_orders=0; purchase_orders=0; internal_supply_products/variants=60/60; internal_supply_links=0; marketplace_bestseller_variants=0. All 767 listings were blocked/unpublished at audit time. These counts are a dated snapshot, not a live guarantee.

## Latest implementation verification (2026-10-11)

- Shopify order ingestion now pages through the paid-order connection newest-first until it finds enough not-yet-imported orders. This prevents a first page of already-imported old orders from starving later orders.
- Each candidate order’s nested line items are fully paginated before variant mapping or order writes. Missing/stalled cursors and duplicate line-item IDs fail closed.
- Autonomous procurement now requires a durable unique `order_automation_runs` claim before loading orders. Existing `running`/`failed` claims, claim persistence errors, and finalization errors stop execution instead of replaying supplier orders blindly.
- Regression checks run before the production build: provider diagnostic contracts (8 assertions), Shopify order pagination/idempotency (15 assertions), autonomous run-claim safety (11 assertions), and dropship order gate invariants (20 cases). The latest preview builds for these changes reached READY; production deploy is also READY at the commit above.
- These checks prove code/build invariants, not a successful live purchase. No production order or purchase order was created by these changes.

## Target boundaries

1. **Connection/auth** — provider-specific OAuth/token lifecycle, secret-safe diagnostics, required-scope verification, read-only probes. No product/order business decisions.
2. **Canonical catalog and identity** — preserve internal product ID, SKU, supplier listing/product/variant IDs, channel IDs, image references, inventory observations, and provenance. Match on stable external IDs; SKU/title/image similarity alone must never silently merge records.
3. **Eligibility policy** — pure validation that returns `eligible` or a list of specific blocking reasons. No network calls or writes.
4. **Channel publication adapters** — create/update/hide operations only after a recorded eligibility decision; persist external IDs immediately and reconcile ambiguous timeouts before retrying.
5. **Order ingestion** — ingest external orders idempotently using channel + external order ID, verify payment/state, and store line-item identity before procurement.
6. **Procurement executor** — revalidate supplier variant, sellable inventory, landed cost, margin, payment authorization, and prior attempts immediately before placing an order. No order from a duplicate or unresolved order.
7. **Reconciliation and patrol** — compare internal state with provider state; emit repair proposals first. Keep the existing `patrol-ai` schedule until its behavior is audited and a replacement is validated.

## Implementation sequence

- [x] Create isolated branch and initial architecture notes.
- [x] Add pure identity, publication-gate, and order-idempotency contracts with no I/O.
- [x] Inspect all scheduled cron routes and map each route to read-only / DB-write / external-write / purchase side effects.
- [x] Confirm the actual TRACER Supabase project through read-only production schema inspection; preserve the existing tables and identifiers.
- [x] Add tests for duplicate identities, missing variant IDs, unknown inventory/cost, non-positive margin, duplicate orders, ambiguous attempts, unpaid/COD orders, unknown/insufficient inventory, kill switch and invalid quantity.
- [x] Add read-only Shopify and BASE probes that report HTTP status, provider identity, scopes/permissions, and sanitized error stage only.
- [ ] Run a dry-run reconciliation against a snapshot and compare proposed actions with existing IDs.
- [ ] Introduce a kill switch / write-mode gate and explicit per-provider write enablement.
- [ ] Only after proof and review, migrate one operation at a time; preserve existing IDs and record rollback steps.

## Acceptance criteria before any production writes

- Shopify Admin API read-only probe returns HTTP 200 and the expected shop ID/domain; all scopes used by code are confirmed.
- BASE refresh succeeds and a read-only API call returns HTTP 200.
- Canonical identity audit shows no unresolved or duplicate external-ID mappings for the intended batch.
- Eligibility decisions include positive, fully costed margin; known stock; valid image and Japanese product copy; verified supplier variant; and publication authorization.
- Order ingest is idempotent for repeated webhooks/cron runs.
- Procurement has a unique idempotency key and cannot run on unverified or unpaid orders.
- Dry-run and reconciliation counts agree with source records; external ACKs are observed, not inferred from a local DB update.
- Rollback plan preserves all provider IDs, inventory, orders, and the existing `patrol-ai` job.

## Non-goals

No production data deletion, bulk unpublish, bulk republish, live order placement, or cron removal as part of this foundation branch.

## Additional verified blockers (read-only, 2026-10-11)

- Listing blocker distribution: 661/767 are supplier_identity_unlinked, 98 supply_gate_missing, 5 japanese_title_required, and 3 japanese_catalog_copy_invalid. All 767 were blocked/unpublished in the queried snapshot.
- Listing evidence counts: 669 have supplier product/variant IDs and identity method, 654 have positive inventory, only 8 have orderable=true, 669 have tracking=true, 767 have positive selling price, and 691 have an HTTP(S) image URL. The main remaining bottlenecks are canonical identity and actual orderability, not listing count.
- The 57,063 supplier candidates are not 57,063 sellable products. A CJ group included 551 rows with verification_status=verified but identity_status=supply_discovered; supplier verification does not prove marketplace identity. internal_supply_links and marketplace_bestseller_variants both had zero rows.
- Production runtime logs contained 14 BASE order API HTTP 400 invalid-access-token errors through 2026-10-10T19:24:38Z, before the required BASE OAuth environment entries were created/updated on 2026-10-11. A fresh read-only BASE list call is needed; historical errors do not prove the new config still fails.
- The protected `main`-only diagnostic workflow is now wired to rerun when either provider diagnostic implementation changes. Its push-triggered run uses `sync_batch=0`, waits for production to reach the triggering commit, and does not perform product/order writes.

## Scheduled-route side-effect inventory

This inventory was checked against the route source on main. It identifies entry points only; it does not assert that an external API call currently succeeds.

| Scheduled route | Main responsibility | Side effects / coupling |
|---|---|---|
| market-sourcing | marketplace observation ingestion | external sourcing + database writes |
| supplier-investigation | supplier candidate investigation and internal-catalog linking | supplier reads + database writes |
| cj-variant-repair | recover supplier variants | supplier reads + database writes |
| cj-identity-reverify | re-check canonical identity evidence | supplier reads + identity/database writes |
| orosy-bulk-import | discover/import Orosy products | supplier reads + database writes + Shopify sync |
| sales-test-publication | opportunity selection and publication | database writes + Shopify sync + BASE publication + NEWFIND delivery |
| shopify-publish | channel listing synchronization | Shopify product/variant/inventory/publication writes |
| inventory-refresh | refresh supplier inventory and storefront state | supplier reads + database writes + BASE item edits |
| demand-match | demand-to-product matching | database writes |
| intelligence | intelligence pipeline and supply selection | database writes + Shopify sync |
| base-orders | BASE order ingestion | BASE reads + order/PO-intent database writes |
| dropship-execution | BASE ingestion then autonomous procurement | BASE reads + database writes + supplier order creation; BASE import failure aborts the later stage |
| shopify-orders | paid Shopify order ingestion | Shopify reads + database writes + autonomous procurement when orders import |
| supplier-reconciliation | reconcile supplier purchase-order state | supplier reads + purchase-order database updates |
| shopify-fulfillment | fulfill/sync Shopify orders | Shopify fulfillment writes + database updates |
| supplier-orders | supplier order status/tracking sync | supplier reads + purchase-order database updates |
| newfind-retry | retry/rescue/withdraw promotion delivery | NEWFIND external writes + database updates |
| supply-first | supplier supply discovery and opportunity intelligence | supplier reads + database writes |
| patrol-ai | patrol/intelligence recovery and delivery rescue | database writes + BASE publication + NEWFIND reconciliation |

## Consequence: channel writes have multiple owners

Shopify synchronization is invoked by the dedicated shopify-publish route and also from sales-test-publication, orosy-bulk-import and intelligence. BASE publication/edit operations are reachable from sales-test-publication, patrol-ai and inventory-refresh. Order ingestion/procurement is reachable from both dropship-execution and shopify-orders, with dropship-execution also re-importing BASE orders that have their own scheduled route.

Do not remove schedules or alter production behavior based on this inventory alone. The refactor should introduce a single channel-neutral eligibility decision and one idempotent delivery owner per channel operation, then convert callers to enqueue/reconcile intents instead of performing direct external writes. Keep current production schedules and external IDs unchanged until shadow comparison and rollback checks pass.


Shadow comparison is a parity signal only. It is not permission to publish: the provider auth preflight, positive-margin eligibility gate, explicit write mode and idempotency/reconciliation checks remain separate mandatory controls.

The isolated core now consists of lib/tracer-core/contracts.ts (exact identity, publication/order gates and ambiguous-write retry classification), lib/tracer-core/auth-contracts.ts (provider auth preflight), and lib/tracer-core/ports.ts (typed channel/order/supplier/repository boundaries plus approval guards for write commands). Regression tests cover these contracts. Existing production routes do not call the new ports yet; wiring must be a separate, tested shadow-comparison step.

### Scheduled overlap (UTC)

| Route | Cron schedule | Note |
|---|---|---|
| orosy-bulk-import | 12:10, 18:10 | Both runs can invoke Shopify sync |
| sales-test-publication | 12:11, 18:11 | Both runs fan out to Shopify, BASE and NEWFIND |
| shopify-publish | 12:14, 18:14 | Separate Shopify write entry point |
| intelligence | 12:22, 18:22, 18:57 | Three runs/day; pipeline also invokes Shopify sync |
| base-orders | 12:25 | BASE order import |
| dropship-execution | 12:30 | Re-imports BASE orders before supplier control |
| shopify-orders | 12:33 | Separate paid Shopify order import and possible supplier control |
| inventory-refresh | 12:15 | Can edit BASE item state |
| patrol-ai | 12:55, 18:59 | Also reaches BASE publication |

The schedules above are read from vercel.json on main. They have intentionally not been changed. The close sequence around 12:10–12:33 UTC means several publication/order paths execute in one window; any consolidation must first prove idempotency and preserve each channel's external IDs.


## Production sales-gate blocker audit (read-only, 2026-10-11)

Direct aggregate queries against the confirmed production Supabase project found:

- `shop_listings`: 661 blocked by `supplier_identity_unlinked`, 98 by `supply_gate_missing`, 5 by `japanese_title_required`, and 3 by `japanese_catalog_copy_invalid` (767 total).
- Of the 661 identity-blocked rows, the linked `supplier_listings` are CJ records with identity state `supply_discovered`: 482 have `verification_status=verified`, and 179 are `retryable`. All 661 have supplier product+variant IDs; all 482 verified rows have confirmed supplier price/inventory and `supplier_listings.orderable=true`. However, the corresponding `shop_listings.orderable` is false for all 661.
- The supplier's `verified` status confirms supplier-side facts; it does not establish exact identity to the marketplace's canonical variant. Do not change `supply_discovered` to `linked` or publish these records merely because supplier IDs, stock, and cost exist.
- `internal_supply_products`: 60/60 active; `internal_supply_variants`: 60 rows but 0 orderable; `internal_supply_links`: 0 rows. `tracer_supply_catalog`: 14 rows, 0 ready/orderable with a sale price and source costs; `tracer_supply_variants`: 0 rows.
- Therefore the principal unblock is not a missing count or a UI issue: canonical marketplace-child-variant evidence is missing for supplier candidates, and the internal catalog has not produced any orderable canonical variant. The safe next step is to inspect the canonical-variant ingestion/identity-evidence path and its runtime audit, not loosen the sales gate.

These are point-in-time, read-only aggregate results. No rows were modified by the audit.
