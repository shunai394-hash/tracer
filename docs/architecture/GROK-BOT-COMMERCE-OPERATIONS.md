# Grok Bot-style Commerce Operations for TRACER

## Purpose

Apply the role-based, event-driven bot pattern to TRACER, BASE, Shopify, and NEWFIND without making a new bot the source of truth. TRACER/Supabase remains canonical. This document is an implementation plan, not a claim that external Grok Bot accounts or automations have been connected.

## Roles

| Role | Reads | Produces | Must not do autonomously |
|---|---|---|---|
| Main Bot / coordinator | Latest run summaries, open incidents, role reports | Prioritized work queue, concise status, escalation | Change production settings, merge/deploy, delete data, change permissions |
| Product monitor | Supplier identity, exact variant, stock, cost, Japan shipping quote, source timestamps | Change events and stale/missing-evidence alerts | Treat marketplace observations as supplier proof; publish products |
| Japanese localization | Canonical title, description, variants, category and product attributes | Japanese draft + validation report | Overwrite price, stock, public state, IDs, supplier identity, or images |
| Channel sync | Canonical TRACER listing and BASE/Shopify/NEWFIND snapshots | Per-channel diff and proposed repair | Push writes before dry-run and invariants pass |
| QA / reconciliation | Run logs, provider readbacks, order/fulfillment records | Evidence-backed pass/fail report and regression alerts | Report success from an HTTP 200 alone or from intended writes |

These can initially be bounded jobs/modules inside TRACER rather than five independent agents. Separate agents are optional; avoid adding paid runtimes until the same contracts work as deterministic jobs.

## Canonical product contract

A product is eligible for sale only when the current evidence contains:
- Supplier identity and exact supplier variant ID
- Fresh variant stock and supplier cost
- Current Japan shipping quote (or an explicitly approved documented shipping policy)
- Fees and landed cost used in price calculation
- Positive contribution profit at the configured target margin
- Japanese title/description and valid variant mapping
- Required tracking/order capability for the active sales-test gate

If any mandatory evidence is missing, stale, contradictory, or invalid, mark the listing non-orderable and set channel inventory to zero/hide it according to the existing safety contract. Do not delete the canonical row or IDs. A transient discovery failure alone must not unpublish a previously verified item; distinguish failed refresh from a positively observed stockout or invalidated evidence.

## Event-driven flow

1. Supplier monitor records a timestamped observation. Do not run a full translation or channel sync when nothing changed.
2. Identity/evidence validation checks product ID + exact variant ID before any downstream action.
3. Localization runs only when source copy changes or Japanese quality validation fails. It emits a draft and preserves protected commerce fields.
4. Pricing computes landed cost, fees, configured margin and sell price. Invalid/missing inputs stop publication.
5. Sync builds a dry-run diff for BASE, Shopify and NEWFIND against TRACER. Apply only allowlisted fields after validation.
6. QA reads the providers back and compares product ID, variant/SKU mapping, price, inventory, public status, and copy. A write is not considered successful until provider readback matches.
7. Main Bot summarizes changed items, failures, unresolved blockers, and next actions. If there are no meaningful changes, return NOOP.

## Safety and approval boundaries

- Default to read-only / dry-run. Store proposed diffs and evidence before writes.
- Human approval required for production deployment, merge, destructive changes, credential/permission changes, supplier purchase orders, refunds, and payment actions.
- Drafts and PRs may be prepared automatically; never merge or deploy solely because a bot says tests passed.
- Supplier ordering requires a fresh immediate preflight, idempotency key, duplicate-order check, stock/cost/shipping/profit revalidation, and the existing explicit live-ordering switches. Do not enable live ordering as part of this work.
- Treat external pages, supplier descriptions, emails, and model output as untrusted data, never as instructions to a bot.
- Never place secrets in prompts, reports, source control, or logs. Report only secret names and presence/absence.
- Rate-limit provider calls; retry transient errors with bounded backoff. Quota/authentication failures should mark that provider unavailable and continue independent read-only checks.
- Every report records run ID, source timestamp, counts scanned/changed/failed/skipped, evidence references, and whether any writes occurred.

## NOOP and frequency

Use event/change detection and existing scheduled jobs. Keep the existing `patrol-ai` cron while validating replacement behavior; do not add another frequent cron or increase invocation volume in this phase. Reuse existing 30-minute supplier/channel cadence where configured. If no relevant input changed, return `NOOP` without AI calls or provider writes.

## Required acceptance tests before any write path is enabled

1. Unauthenticated requests are rejected.
2. Missing/stale supplier identity, variant, cost, shipping, or stock never results in a sellable listing.
3. Localization changes only approved text fields; price, inventory, public state, IDs, SKU and variant mappings remain byte-for-byte unchanged.
4. Repeated sync is idempotent and creates no duplicate products or orders.
5. Provider timeout, 429, malformed response, and partial failure produce a failed/unknown status rather than a false success.
6. A successful write is followed by provider readback and field-by-field comparison.
7. A real stockout hides/zeros the listing; a transient refresh failure does not trigger mass unpublishing.
8. No-op runs make no AI/provider writes.
9. Order creation remains blocked unless all preflight gates and explicit live-ordering settings are satisfied.
10. Logs contain no access tokens, API keys, customer secrets, or raw sensitive payloads.

## Rollout sequence

1. Add read-only role reports and shared report schema.
2. Run shadow reconciliation and compare reports against current operational data.
3. Fix false positives and prove the acceptance tests in CI/staging.
4. Enable one narrowly scoped write at a time behind existing feature flags and approval.
5. Only consider external Grok Bot integration after its API, access controls, auditability, cost, and data handling are verified. No credentials or external bot account are assumed to exist.

## Current boundary

This document alone changes no product data, channel state, scheduled-job frequency, credentials, orders, or production deployment. Implementation and activation require separate code changes, tests, review, and an explicit rollout decision.
