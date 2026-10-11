# TRACER commerce-core separation plan

## Safety boundary

This branch is an isolated refactor foundation. It does not change the production cron schedule, existing tables, deployed routes, or channel write behavior. Do not merge or enable write paths until the acceptance checks below pass.

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

The initial pure contracts in lib/tracer-core/contracts.ts and lib/tracer-core/auth-contracts.ts are only the first isolated layer; existing routes do not call them yet. Integration must be a separate, tested step.
