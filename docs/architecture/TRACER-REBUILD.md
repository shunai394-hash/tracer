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
- [ ] Inspect all cron routes and map each route to read-only / DB-write / external-write / purchase side effects.
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
