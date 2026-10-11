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


## Live GitHub Actions evidence observed during this audit

Read-only Actions API/log inspection found two recent `TRACER Production Smoke` runs on `main`:
- Run [38105600205](https://github.com/shunai394-hash/tracer/actions/runs/38105600205), started 2026-10-11 02:34:35 UTC (11:34:35 JST), failed during the post-deploy AI patrol step.
- Run [38107191022](https://github.com/shunai394-hash/tracer/actions/runs/38107191022), started 2026-10-11 03:04:07 UTC (12:04:07 JST), failed during the post-deploy AI patrol step.

Both runs did perform writes before failing:
- Demand-match matcher ran twice and persisted 9 evidence rows; the second pass kept the observed counts/classification stable (idempotent for that specific scenario).
- The patrol pipeline inserted 10 bestseller records and 10 auxiliary trend records in each run and created one product in each run (product count rose 1524→1525 in the first and 1525→1526 in the second).
- The patrol pipeline then exceeded its 20-second identity-reverification step budget; subsequent steps were deferred and the endpoint returned HTTP 500.
- Both patrol reports show `publishedListings=0`, `basePublished=0`, and `orders=0` before and after. No listing publication or order creation was reported by those two runs.

This is direct evidence that a workflow called “Production Smoke” was not read-only. It was triggered by `push` to `main` and executed live demand-match and AI-patrol paths before failing. The branch now removes automatic push triggers and adds explicit `allow_production_writes=true` approval guards to `tracer-production-smoke.yml`, `tracer-direct-900.yml`, `tracer-build-1000.yml`, `tracer-expand-1000.yml`, `tracer-publish-cj-now.yml`, `tracer-run-sales-test-now.yml`, `tracer-live-shopify-sync.yml`, and `tracer-one-shot-supply-recovery.yml. These edits are only on the draft branch; they have not changed main or production.


## Historical scheduled workflow evidence (read-only run-log inspection)

- [TRACER Autonomous Commerce Cycle run 37865473140](https://github.com/shunai394-hash/tracer/actions/runs/37865473140), 2026-10-09 00:34:31 UTC, was a successful **workflow run**, not a successful sales/publication outcome. It called the live sales-test, Shopify publish and dropship endpoints. Sales-test reported `candidateCount=0` and `published=0`; the Shopify sync attempted 150 listings and reported `Shopify Admin API HTTP 401` for them; dropship execution reported `attempted=0`, `succeeded=0`, and no purchase-order IDs. BASE order sync was not configured. This confirms the run reached write-capable paths, but these result fields show no successful listing publication or supplier order in the returned summary.
- [TRACER Production Patrol run 38029045230](https://github.com/shunai394-hash/tracer/actions/runs/38029045230), 2026-10-10 05:53:36 UTC, obtained a production OIDC token and called `/api/cron/patrol-ai`, but the client timed out after 55 seconds with zero response bytes. The actual server-side outcome is **unknown**; do not interpret the client timeout as proof that the function did not write.
- The scheduled Commerce Cycle and NEWFIND Retry runs visible on Oct 9 are historical. Their presence in run history does not establish that those workflows are still scheduled by the current YAML. Current-source trigger review is separate from historical execution evidence.

## Current protection changes on the draft branch

The current main branch's `tracer-patrol.yml` schedule is still present; this branch does not disable it. The `patrol-ai` endpoint is guarded by the capability mode on the branch, so after a future merge/deployment it will be blocked when the mode is missing/invalid or the global stop is active. The other listed push-triggered production-write workflows have been changed to manual-only with a required `allow_production_writes=true` job condition on this branch. CI tests check that those eight workflows have no push trigger and retain the approval gate.


Additional historical scheduled runs:
- `TRACER Supply First Patrol` run [37873013091](https://github.com/shunai394-hash/tracer/actions/runs/37873013091) failed on 2026-10-09 around 02:06 UTC. The workflow requested OIDC tokens with audience `https://tracer-self.vercel.app`, while the route auth code requires `https://tracer-pied-alpha.vercel.app`; the called endpoints returned 401 Unauthorized. The inspected log shows no successful stage.
- `TRACER NEWFIND Retry` run [37863390933](https://github.com/shunai394-hash/tracer/actions/runs/37863390933) failed around 00:10 UTC with HTTP 401 Unauthorized using the same `tracer-self.vercel.app` audience. The returned evidence shows the request was rejected before the route ran.
