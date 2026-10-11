# TRACER commerce-core separation plan

## Safety boundary

This branch is an isolated refactor foundation. It does not change the production cron schedule, database schema, deployed route definitions, or external IDs. One intentional fail-closed policy change is included: the existing sales-test gate now rejects an unknown contribution profit. That can only remove eligibility, not make a blocked listing eligible. No production data writes or external channel calls were made during this work. Do not merge or enable new write paths until the acceptance checks below pass.

## Audit snapshot (2026-10-11)

- Production deployment reported READY at commit `8a02ac33e5482b2e8b7d5f495f635b58e4292bb1`; this confirms deployment status, not external API authentication.
- Shopify auth recovery on HTTP 401 was merged, but a successful authenticated read-only Admin API response and the expected shop identity have not yet been verified.
- BASE code supports OAuth refresh-token exchange and checks four required environment variables. A configured flag is not proof that the refresh token is valid; perform a read-only API call to prove it.
- `vercel.json` contains scheduled routes for discovery, supplier investigation, variant repair, sales-test publication, Shopify publication, inventory refresh, BASE orders, dropship execution, Shopify orders, supplier reconciliation, fulfillment, supplier orders, and `patrol-ai`. This means production writes may be triggered by scheduled routes independently of a manual diagnostic.
- `app/api/cron/dropship-execution/route.ts` combines BASE order sync and autonomous supplier-order control in one route. Separate these responsibilities behind explicit stages and durable idempotency.
- `lib/channels/base-publisher.ts` combines catalog copy validation, identity checks, database state changes, BASE visibility changes, and remote item creation/editing. Split policy evaluation from the external adapter and persistence/reconciliation.
- `app/api/cron/shopify-publish/route.ts` invokes synchronization directly after its automation auth/config checks. A future write executor must additionally require a recorded passing preflight and explicit mode.
- Confirmed TRACER Supabase project: `lysavahpadzrhpounjgi` (Tokyo). Read-only schema/data audit observed products=1,525; supplier_listings=57,063; shop_listings=767; shop_orders=0; purchase_orders=0; internal_supply_products/variants=60/60; internal_supply_links=0; marketplace_bestseller_variants=0. All 767 listings were blocked/unpublished at audit time. These counts are a dated snapshot, not a live guarantee.

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
- [ ] Add read-only Shopify and BASE probes that report HTTP status, provider identity, scopes/permissions, and sanitized error stage only.
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
- A branch-only Shopify auth probe returned outer HTTP 401 because lib/security/cron-auth.ts intentionally only accepts GitHub OIDC tokens from refs/heads/main. That result is an authorization rejection before the Shopify probe, not a Shopify API 401. Keep the production allowlist unchanged; use the existing main-only auth-check workflow with sync_batch=0.

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
