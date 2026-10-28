# TRACER Commerce Bot Control Plane

## Purpose

Coordinate five focused bots around TRACER as the canonical catalog and BASE, Shopify, and NEWFIND as downstream channels. The control plane is a coordinator and evidence ledger, not a replacement for the existing provider adapters.

## Bot responsibilities

| Bot | Responsibility | Existing integration points | Initial mode |
|---|---|---|---|
| Main Bot | Priorities, cross-bot progress, stop conditions, incident summary | `/api/cron/patrol-ai` | Read-only orchestration |
| Product Monitor Bot | Supplier product/variant identity, cost, Japan shipping, inventory and tracking evidence | `/api/cron/supply-first`, `/api/cron/inventory-refresh` | Detect/report first |
| Japanese Copy Bot | Japanese title/description, missing attributes, unsupported claims, read-back verification | `/api/cron/base-japanese-copy` | Existing route; report update/read-back outcomes |
| Channel Sync Bot | TRACER vs BASE/Shopify/NEWFIND IDs, SKU, price, stock and publication | `/api/admin/shopify/reconcile`, `/api/cron/shopify-publish`, `/api/cron/newfind-retry` | Read-only reconciliation before any write |
| QA Bot | Test/build/deploy/live-data evidence and discrepancy report | `/api/health`, read-only reconciliation, test suite | Read-only |

## Safety and product eligibility

1. Use supplier product ID + supplier variant ID + channel product/variant IDs/SKU as identity evidence. Never silently merge based on title or image similarity.
2. Do not consider an item publishable unless supplier identity, variant, positive inventory, Japan shipping, tracking capability, known non-zero cost/shipping and the configured margin rule are evidenced.
3. Keep read-only audits separate from external writes. A write plan must name exact target IDs, before/after values, evidence, idempotency key, and rollback/recovery action.
4. After each write, fetch the provider state again. An accepted API response alone is not proof of final public state.
5. A Main Bot must not bypass the existing publication, identity, order, or supplier safety gates.
6. Keep purchase/order creation disabled in any new orchestration path until a separately authorized end-to-end test proves customer order → supplier order → tracking back to the channel.
7. Never expose tokens, secrets, customer PII, or full addresses in bot reports.

## Implemented control-plane foundation

- `lib/agents/commerce-bot-control-plane.ts` defines the five roles and their known integration points.
- `GET /api/admin/bots/status` requires the existing automation authentication and returns a no-store, read-only configuration report.
- The status response deliberately marks every check as `not-run`; configured credentials or an existing route are not presented as a successful audit.
- Channel Sync readiness requires BASE OAuth settings, Shopify store domain plus one valid supported auth mode, and NEWFIND outbound API settings; it does not infer readiness from `CRON_SECRET` alone.
- The control-plane test covers missing provider configuration, both supported Shopify auth modes, and the no-false-success contract.
- The endpoint does not execute cron routes, modify database rows, or write to external channels.

## Rollout plan

### Stage 1 — Status and evidence contracts
- [x] Define five bot roles and safety gates.
- [x] Add authenticated, read-only status endpoint.
- [x] Add automated unit tests for missing configuration and no-false-success semantics (execution still needs CI/local verification).
- [ ] Confirm the route is included in deployment and test the auth boundary.

### Stage 2 — Durable run/evidence records
- [x] Additive Supabase migration for append-only `commerce_bot_run_events` with run ID, bot ID, event type/status, timestamp, input snapshot hash, evidence refs, blockers, retry count and idempotency key.
- [x] Add a payload validation contract and regression tests wired into `prebuild`.
- [x] Restrict table access to `service_role`; enable RLS and revoke update/delete/truncate so evidence is appended, not rewritten.
- [x] Add the server-side event writer and authenticated read-only run history endpoint (code present; runtime and DB still unverified).
- [x] Add static guardrail assertions for the run-history endpoint.
- [ ] Apply the reviewed migration to Supabase and verify grants/RLS in the target environment.
- [x] Add an additive per-channel lease migration with atomic acquire, bounded expiry, and token-checked release (runtime integration and DB application remain unverified).

### Stage 3 — Read-only monitors
- Supplier monitor detects changed cost, shipping, inventory, identity and tracking evidence.
- Channel Sync compares real provider state against TRACER canonical IDs/SKU/price/stock/publication.
- QA Bot aggregates tests, provider reads and mismatches, retaining partial-scan and API-error states as unknown rather than success.

### Stage 4 — Japanese copy workflow
- Generate Japanese copy into a reviewable candidate.
- Validate facts against supplier attributes; reject unsupported claims and unverified dimensions/materials.
- Update in small bounded batches, then fetch the exact item again and verify title/description while confirming price, stock and publication did not drift.

### Stage 5 — Guarded write executor
- Only run after preflight evidence is fresh and passing.
- Separate BASE, Shopify and NEWFIND write adapters.
- Enforce idempotency, bounded batches, rate limits, retries, dead-letter reporting and post-write read-back.
- Never let the Main Bot call provider writes directly.

### Stage 6 — End-to-end sales proof
- Use an explicitly approved test order and prove customer order ingestion, supplier order creation, supplier order ID, tracking receipt and tracking propagation.
- Report code implementation, CI, deployment, provider-side verification and actual sales proof as separate statuses.

## API

`GET /api/admin/bots/status` — requires `Authorization: Bearer <CRON_SECRET>` or the existing trusted GitHub OIDC automation token. Returns bot definitions, missing configuration, guardrails and a generated timestamp. It does not execute a bot or claim live data was checked.

`GET /api/admin/bots/runs?limit=50&botId=channel-sync&runId=<uuid>` — uses the same automation authentication boundary; returns recent append-only run events, optionally filtered by bot or run ID. The route is code-complete but requires deployment and a migrated database table before it can return ledger records.

## Acceptance criteria

- No external write happens from the status endpoint.
- Unauthorized requests return 401.
- Every bot run has an explicit state: `not-run`, `running`, `passed`, `blocked`, `partial`, or `failed`.
- Missing credentials, partial scans, stale evidence and API errors cannot be reported as `passed`.
- Every channel write is followed by provider read-back and a discrepancy report.
