# TRACER Multi-Bot Operations — Read-Only Phase

## Purpose

Create one Main Bot that coordinates four specialist roles across TRACER, BASE, Shopify, and NEWFIND. This first phase is a deterministic analysis engine: it accepts already-read snapshots, emits prioritized findings/tasks, and does not write to databases or sales channels.

## Bot contracts

| Bot | Responsibility | Output |
| --- | --- | --- |
| Main Bot | Sort work by severity, group tasks by product identity, keep unresolved issues visible | Prioritized read-only task list |
| Product Monitor Bot | Detect price/stock/cost changes against a prior snapshot; flag unknown/zero supplier cost or Japan shipping; flag margin below 50% | Change and eligibility findings |
| Japanese Copy Bot | Detect missing/empty/non-Japanese title and description | Human-review translation tasks; it does not overwrite source copy |
| Sync Bot | Compare TRACER expected price/stock/publication state with BASE, Shopify, and NEWFIND snapshots | Channel-specific mismatches |
| QA Bot | Reject incomplete/duplicate stable identity and missing/invalid selling price | Critical/high findings requiring human review |

## Identity policy

A product key is valid only when TRACER product ID, supplier product ID, and supplier variant ID are all present. Channel comparison also requires external product ID and exact SKU equality. Title matching is never used to link products or resolve conflicts. Shopify variants should include their external variant ID in the snapshot.

## Business rules

- Source of truth: TRACER. BASE, Shopify, and NEWFIND are downstream channels.
- Supplier cost and Japan shipping must be known and greater than zero to evaluate margin.
- Expected margin target is at least 50%: (selling price - supplier cost - Japan shipping) / selling price.
- Unknown identity, cost, stock, or channel state never triggers automatic publication, restock, repricing, or deletion.
- Japanese-copy findings create review tasks only; translations are not written automatically.
- Every generated task has readOnly: true; all findings requiring a state change are marked for human approval.

## Data flow

1. A future authenticated adapter reads TRACER and channel snapshots using existing approved read paths.
2. Adapter normalizes fields into OperationsProductSnapshot.
3. runReadOnlyOperationsBots() evaluates snapshots and optionally a previous snapshot.
4. Main Bot sorts specialist tasks by priority and returns a report.
5. QA/human reviewer verifies evidence and approves any future separately implemented change request.

The PR implements the deterministic engine and a protected canonical-data report. It also adds an explicit live-read endpoint at `/api/admin/ops-bots/live-channel-check?live=1`: BASE detail reads are capped at 5 existing item IDs and Shopify GraphQL reads at 20 existing product IDs. The endpoint never searches by title and never writes to DB or channels. NEWFIND live price/stock verification remains unimplemented; persisted listing rows are reported only. The endpoint does not persist snapshots or run on a schedule.

## Safety and non-goals

- No DB schema/data changes.
- No listing publication, price/stock update, delete, order, supplier order, or external API write.
- No automatic translation writeback.
- No secrets, supplier credentials, supplier costs, or margin figures are sent to an LLM or public channel.
- Read-only engine has no network or persistence code.
- Live reads require an explicit `?live=1` flag and automation authentication; ordinary report requests do not call external channel APIs. BASE and Shopify reads are bounded, but the returned samples are diagnostic only and are not yet joined to canonical variants for a complete parity verdict. NEWFIND live adapter, durable snapshot history, scheduled shadow runs, and full cross-channel variant reconciliation remain future work.

## Test

Run npm run test:read-only-ops-bots.

The test uses synthetic fixtures for clean parity, price/stock/cost changes, low margin, non-Japanese copy, identity mismatch, incomplete identity, duplicate identity, and unknown/zero costs. It does not call external services.
