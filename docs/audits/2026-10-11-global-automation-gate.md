# TRACER automation gate coverage finding — 2026-10-11

Scope: source-only inspection on `main`, recorded on `audit/cron-side-effects-20261011`. No production settings or data were changed.

## Confirmed

- `requireAutomationAuth` in `lib/security/cron-auth.ts` accepts either the configured `CRON_SECRET` bearer token or a verified GitHub OIDC token scoped to repository `shunai394-hash/tracer`, ref `refs/heads/main`, and the expected audience. It authenticates callers; it does not classify or block side effects.
- `lib/ops/kill-switch-eval.ts` supports a global scope plus supplier/product/user scopes, and its pure invariant helper covers the global match behavior.
- The DB-backed `checkKillSwitch` is called in the supplier-order execution path. The inspected publication routes `shopify-publish`, `sales-test-publication`, `intelligence`, and `patrol-ai` do not invoke that kill-switch helper before their channel writes.
- Therefore, a global kill-switch row existing in the database is not evidence that all scheduled writes are globally stopped. The current implementation has no verified, universal write-capability gate at the Cron entry point.

## Required design before wiring

Use explicit capabilities rather than one ambiguous boolean:
- `read_only_diagnostic`: only safe reads and sanitized diagnostic output.
- `database_write`: any mutation to TRACER tables, including run-state/telemetry and inventory reservations.
- `channel_write`: Shopify/BASE/NEWFIND publish, update, hide, unpublish, fulfillment or tracking mutation.
- `supplier_order`: external supplier order creation/payment; keep distinct from internal fulfillment-row creation.

A single shared guard must run before side effects in every scheduled route and every indirectly callable write helper. Unknown/missing mode must deny write capabilities (fail closed); the code must not rely on route authentication, supplier kill-switch checks, or `vercel.json` as substitutes. Diagnostic/read-only mode must not silently invoke pipeline functions that persist run state.

## Test requirements

- Missing/unknown mode denies every write capability.
- Explicit read-only mode permits only diagnostic operations, and blocks database writes, channel writes, and all order execution.
- Global kill switch blocks all write capabilities; supplier/product scopes remain narrower.
- Each scheduled route declares its required capability and tests assert all `vercel.json` Cron paths are covered.
- Indirect calls from `patrol-ai`, `intelligence`, `sales-test-publication`, `orosy-bulk-import`, and both order ingestion routes cannot bypass the guard.
- No tests should call production APIs; inject fakes and assert no DB/channel/order mutation functions are reached.

## Runtime limitation

Vercel project inspection is still blocked by a 403 for team `team_shunai394-9704s-projects`; actual production mode, Cron activation and recent runs are unknown. Keep this work on the audit branch; do not deploy the guard or change production configuration until the runtime inventory is accessible and the behavior is reviewed.
