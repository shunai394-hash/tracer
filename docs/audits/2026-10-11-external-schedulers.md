# TRACER external scheduler audit — 2026-10-11

Scope: GitHub Actions workflow source on `main` plus Vercel `vercel.json`. This does not query GitHub's live run history, so it identifies configured triggers, not proof of the latest execution.

## Confirmed independent scheduled trigger

`.github/workflows/tracer-patrol.yml` has:
- `schedule: 17 0 * * *` = daily at 00:17 UTC / 09:17 JST.
- It obtains a GitHub OIDC token for the production deployment and calls `https://tracer-pied-alpha.vercel.app/api/cron/patrol-ai`.
- `patrol-ai` is not a passive diagnostic: its route runs the intelligence pipeline, updates `cron_runs`, can call `publishPublishedListingsToBase(3)`, and attempts NEWFIND recovery. This GitHub schedule is separate from the Vercel Cron entries for `patrol-ai` at 12:55 UTC and 18:59 UTC.

Consequently, removing or editing the Vercel Cron entry alone would not stop the GitHub Actions schedule. Conversely, this audit did not change either schedule.

## Manually invokable production-write workflows

The workflow directory also contains manual workflows that obtain production OIDC tokens and call live endpoints. Examples confirmed by source inspection:
- `tracer-autonomous-commerce-cycle.yml`: manual-only; runs CJ identity re-verification, sales-test publication, Orosy import, sourcing/investigation, intelligence, BASE publication, Shopify publication and dropship execution.
- `tracer-product-trace.yml`: manual-only; supports calling supply-first, intelligence and sales-test publication.
- `tracer-one-shot-supply-recovery.yml`: manual-only; calls supply-first, sales-test publication, BASE publication and Shopify sync (its workflow contains a dry-run preview and a separate write path).
- `tracer-shopify-auth-check.yml`: manual workflow; its input controls whether it stays read-only/dry-run or proceeds to sync/reconcile, so the safe input must be checked before dispatch.
- `tracer-sales-test-patrol.yml`, `tracer-run-sales-test-now.yml`, `tracer-publish-cj-now.yml`, `tracer-reach-500-now.yml`, `tracer-expand-1000.yml`, `tracer-build-1000.yml`, and `tracer-supply-first.yml` contain live route calls. Their trigger configuration and branch guards should be reviewed before any manual dispatch.
- `tracer-sales-test-now.yml` has a `push` trigger on `main` but the job is additionally guarded by a commit-message marker `[run-sales-test-now]`; ordinary commits without that marker do not enter that job.
- `tracer-direct-900.yml` can run on `main` pushes affecting itself or `scripts/direct-900-gate.ts`, as well as manually; it pulls production environment through Vercel OIDC and runs a gate script against the production DB. The script's exact DB effects should be reviewed before treating this as read-only.

## Immediate implication

The shared `requireAutomationCapability` guard now added on the audit branch is enforced by the 19 Vercel-scheduled routes. If merged and deployed without setting `TRACER_AUTOMATION_MODE`, these Cron routes will fail closed; that is intentional but would block scheduled automation. The guard does **not** by itself disable an external GitHub workflow that calls a route outside the gated list, nor does it stop workflow jobs from running their pre-call steps. The existing scheduled `tracer-patrol.yml` calls the gated `patrol-ai` route, so after deployment it will receive a 503 unless the configured mode permits its `channel_write` capability or the global stop is set.

## Required next steps

1. Audit live GitHub Actions run history for `tracer-patrol.yml` and recent manual/write workflows; do not infer run state from YAML.
2. Ensure every live-write API endpoint called by a workflow is covered by the same capability guard, not just the 19 Vercel Cron routes.
3. Add a workflow policy that prevents production-write workflow dispatch unless an explicit reviewed input/approval is supplied; keep production dispatch disabled during this audit.
4. Do not delete or disable existing workflows or schedules without an approved operational transition plan. No workflow was dispatched and no schedule was changed during this audit.
