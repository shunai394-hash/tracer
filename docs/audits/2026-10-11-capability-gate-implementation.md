# TRACER capability-gate implementation status — 2026-10-11

Branch: `audit/cron-side-effects-20261011`
Draft PR: https://github.com/shunai394-hash/tracer/pull/234

## Code changes now present on the branch

- `lib/ops/automation-capabilities.ts` defines `disabled`, `diagnostic`, and `writes_enabled`; missing or invalid mode is denied, and a global stop blocks every capability.
- `lib/security/cron-auth.ts` adds `requireAutomationCapability`, which authenticates the caller and then applies the explicit capability decision. Authenticated callers no longer automatically gain permission to write.
- All 19 unique routes referenced by `vercel.json` now declare a capability gate. The same guard is also applied to eight additional write endpoints: BASE publication, core-engine, demand, unpublish-unlinked, Super Delivery sales route, ai-patrol delegation, Shopify admin sync (after its dry-run branch), and intelligence demand-match.
- `scripts/direct-900-gate.ts` checks the capability policy before creating the admin client or starting its production data/publish loop.
- `tracer-direct-900.yml`, `tracer-production-smoke.yml`, `tracer-build-1000.yml`, `tracer-expand-1000.yml`, `tracer-publish-cj-now.yml`, `tracer-run-sales-test-now.yml`, `tracer-live-shopify-sync.yml`, and `tracer-one-shot-supply-recovery.yml` no longer start on every matching push. All eight require a manual `allow_production_writes=true` input before their jobs can run.
- CI includes `scripts/test-automation-capabilities.mjs`, which checks the policy and that scheduled/additional protected routes are covered, and checks the eight push-triggered production-write workflows retain explicit approval guards.

## Behavior / deployment warning

This is a fail-closed change. In a deployment where `TRACER_AUTOMATION_MODE` is missing or invalid, the protected write endpoints return HTTP 503 before executing the protected path. `diagnostic` mode blocks all write capabilities; `writes_enabled` is required to allow them, and `TRACER_GLOBAL_STOP=1` blocks them again.

This branch is not merged or deployed. No production environment variable, Vercel Cron, GitHub Actions schedule, product listing, order, fulfillment or production database was changed. Do not merge until CI passes and the production configuration transition is explicitly reviewed; after a future deployment, the scheduled automation will remain blocked until the mode is intentionally configured.

## Remaining scope

- The external GitHub schedule `tracer-patrol.yml` still exists and runs daily at 09:17 JST. Its `/api/cron/patrol-ai` call is covered by the route gate, but the workflow itself has not been disabled.
- Manual production-write workflows remain available unless explicitly gated above. Their endpoints must be inventoried for any path that can bypass the protected route set.
- Vercel live Cron state/logs remain unknown because read-only team access returned 403.
- CI result for the latest branch head must be checked before considering the implementation validated.
