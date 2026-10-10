import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";
import { linkInternalSupplyForBestseller } from "@/lib/suppliers/internal-catalog";
import { selectDueInternalLinkRetryIds } from "@/lib/suppliers/cj-identity-reverify-policy";
import { syncTracerCatalogFromInternalSupply } from "@/lib/suppliers/sync-tracer-catalog";
import { createPersistedLinkVerifier, createRetryQueueStore, isInternalLinkRetryDue, processInternalLinkCandidates } from "@/lib/suppliers/internal-link-retry-lifecycle";

export const runtime = "nodejs";
export const maxDuration = 300;

const INVESTIGATION_BUDGET_MS = 200_000;
const IDENTIFIER_FILTER = "jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null,mpn.not.is.null,asin.not.is.null";

function identityPriority(row: Record<string, unknown>): number {
  let score = 0;
  if (typeof row.jan === "string" && row.jan.trim()) score += 100;
  if (typeof row.gtin === "string" && row.gtin.trim()) score += 95;
  if (typeof row.ean === "string" && row.ean.trim()) score += 90;
  if (typeof row.upc === "string" && row.upc.trim()) score += 85;
  if (typeof row.mpn === "string" && row.mpn.trim()) score += 70;
  if (typeof row.asin === "string" && row.asin.trim()) score += 45;
  return score;
}

function prioritizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => {
    const priority = identityPriority(b) - identityPriority(a);
    if (priority !== 0) return priority;
    return String(b.fetched_at ?? b.pipeline_updated_at ?? "").localeCompare(
      String(a.fetched_at ?? a.pipeline_updated_at ?? ""),
    );
  });
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
    await recoverStaleCronRun(supabase, "supplier-investigation", maxDuration);

    const { data: cronRun, error: claimError } = await supabase
      .from("cron_runs")
      .insert({
        job_name: "supplier-investigation",
        status: "running",
        metadata: { phase: "supplier_investigation" },
      })
      .select("id")
      .single();

    if (claimError) {
      if (claimError.code === "23505") {
        return NextResponse.json(
          { ok: true, skipped: true, reason: "cron_already_running", job: "supplier-investigation" },
          { status: 409 },
        );
      }
      throw new Error(claimError.message);
    }

    cronRunId = cronRun?.id ? String(cronRun.id) : null;

    // Durable internal-link retries are selected first. The retry table is
    // the source of truth for failure reason, identifiers, attempt count and due time.
    const { data: retryStateRows, error: retryStateError } = await supabase
      .from("internal_supply_link_retry_queue")
      .select("bestseller_id,supplier_listing_id,supply_variant_id,reason,link_status,retry_count,next_attempt_at")
      .order("next_attempt_at", { ascending: true })
      .limit(5000);
    if (retryStateError) throw new Error(`internal link retry queue lookup failed: ${retryStateError.message}`);

    const retryStateById = new Map(
      (retryStateRows ?? []).map((row) => [String(row.bestseller_id), row]),
    );
    const dueRetryIds = selectDueInternalLinkRetryIds(
      (retryStateRows ?? []).map((row) => ({
        bestseller_id: String(row.bestseller_id),
        next_attempt_at: row.next_attempt_at ? String(row.next_attempt_at) : null,
      })),
      Date.now(),
      BESTSELLER_CANDIDATE_BATCH_SIZE,
    );

    // Pull a wider queue, then spend the limited supplier-call budget on the
    // strongest strict identity evidence first. ASIN/MPN are intentionally
    // retained because investigate-dropship can enrich them before matching.
    const queuePoolSize = Math.max(BESTSELLER_CANDIDATE_BATCH_SIZE * 5, 50);
    const { data: freshRows, error: freshError } = await supabase
      .from("marketplace_bestsellers")
      .select("id,jan,gtin,ean,upc,mpn,asin,fetched_at")
      .in("pipeline_status", ["pending", "failed"])
      .or(IDENTIFIER_FILTER)
      .order("fetched_at", { ascending: false })
      .limit(queuePoolSize);

    if (freshError) throw new Error(freshError.message);

    const freshCandidateIds = prioritizeRows(
      (freshRows ?? []) as unknown as Record<string, unknown>[],
    )
      .filter((row) => {
        const queued = retryStateById.get(String(row.id));
        return !queued || isInternalLinkRetryDue(queued.next_attempt_at ? String(queued.next_attempt_at) : null);
      })
      .map((row) => String(row.id));

    let candidateIds = [...dueRetryIds, ...freshCandidateIds]
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE);

    if (candidateIds.length < BESTSELLER_CANDIDATE_BATCH_SIZE) {
      const retrySlots = BESTSELLER_CANDIDATE_BATCH_SIZE - candidateIds.length;
      const retryBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: retryRows, error: retryError } = await supabase
        .from("marketplace_bestsellers")
        .select("id,jan,gtin,ean,upc,mpn,asin,pipeline_updated_at")
        .eq("pipeline_status", "blocked")
        .lt("pipeline_updated_at", retryBefore)
        .or(IDENTIFIER_FILTER)
        .order("pipeline_updated_at", { ascending: true })
        .limit(Math.max(retrySlots * 5, 20));

      if (retryError) throw new Error(retryError.message);

      // Blocked rows used to be retried oldest-first regardless of identity
      // quality. That could repeatedly consume the whole budget on ASIN-only
      // rows. Keep retry fairness, but prefer rows that can actually establish
      // strict supplier identity.
      const prioritizedRetries = prioritizeRows(
        (retryRows ?? []) as unknown as Record<string, unknown>[],
      ).filter((row) => {
        const queued = retryStateById.get(String(row.id));
        return !queued || isInternalLinkRetryDue(queued.next_attempt_at ? String(queued.next_attempt_at) : null);
      }).slice(0, retrySlots);

      candidateIds = [...candidateIds, ...prioritizedRetries.map((row) => String(row.id))]
        .filter((id, index, ids) => ids.indexOf(id) === index)
        .slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE);
    }

    const internalMatchedIds: string[] = [];
    const internalResults: Record<string, unknown>[] = [];
    const internalLinkFailures: Array<Record<string, unknown>> = [];
    const internalLinkReasonCounts: Record<string, number> = {};
    const internalLinkStatusCounts: Record<string, number> = {};
    const externalCandidateIds: string[] = [];

    const bestsellers = new Map<string, Record<string, unknown>>();
    const outcomes = await processInternalLinkCandidates(candidateIds, {
      loadBestseller: async (candidateId) => {
        const { data, error } = await supabase
          .from("marketplace_bestsellers")
          .select("*")
          .eq("id", candidateId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (data) bestsellers.set(candidateId, data as Record<string, unknown>);
        return (data as Record<string, unknown> | null) ?? null;
      },
      linkInternalSupply: (bestseller) => linkInternalSupplyForBestseller({
        bestseller,
        fetchedAt: String(bestseller.fetched_at ?? new Date().toISOString()),
      }),
      syncCatalog: ({ bestsellerId, bestseller, supplyVariantId }) => syncTracerCatalogFromInternalSupply({
        bestsellerId,
        salePrice: Number.isFinite(Number(bestseller.price)) ? Number(bestseller.price) : null,
        variantIds: supplyVariantId ? [supplyVariantId] : [],
      }),
      verifyPersistedLink: createPersistedLinkVerifier(supabase as never),
      retryQueue: createRetryQueueStore(supabase as never),
      priorRetryCount: (candidateId) => Number(retryStateById.get(candidateId)?.retry_count ?? 0),
    });

    const internalLinkErrors: Array<Record<string, unknown>> = [];
    for (const outcome of outcomes) {
      const candidateId = outcome.candidateId;
      if (outcome.status === "not_found") {
        externalCandidateIds.push(candidateId);
        continue;
      }
      if (outcome.status === "candidate_error") {
        // e.g. the retry row could not be written: durability lost, surfaced below.
        internalLinkErrors.push({ bestsellerId: candidateId, error: outcome.error });
        continue;
      }
      const link = outcome.link;
      internalLinkReasonCounts[link.reason] = (internalLinkReasonCounts[link.reason] ?? 0) + 1;
      if (link.linkStatus) {
        internalLinkStatusCounts[link.linkStatus] = (internalLinkStatusCounts[link.linkStatus] ?? 0) + 1;
      }
      const title = String(bestsellers.get(candidateId)?.title ?? "");

      if (outcome.status === "link_not_matched") {
        internalLinkFailures.push({
          bestsellerId: candidateId,
          title,
          supplierListingId: link.supplierListingId,
          supplyVariantId: link.supplyVariantId,
          reason: link.reason,
          linkStatus: link.linkStatus ?? null,
          retryCount: outcome.retryCount,
          nextAttemptAt: outcome.nextAttemptAt,
        });
        externalCandidateIds.push(candidateId);
        continue;
      }
      if (outcome.status === "catalog_sync_retry") {
        // Canonical link exists but the catalog is not verified: not a match.
        internalLinkFailures.push({
          bestsellerId: candidateId,
          title,
          supplierListingId: link.supplierListingId,
          supplyVariantId: link.supplyVariantId,
          reason: "catalog_sync_failed",
          linkStatus: outcome.kind === "rejected" ? "catalog_sync_rejected" : outcome.kind === "exception" ? "catalog_sync_error" : "catalog_link_unverified",
          detail: outcome.reason,
          retryable: true,
          retryCount: outcome.retryCount,
          nextAttemptAt: outcome.nextAttemptAt,
        });
        continue;
      }
      if (outcome.status === "retry_cleanup_failed") {
        // The link and catalog are verified; the retry row survives and the
        // next sweep re-runs this candidate idempotently before deleting it.
        internalLinkErrors.push({ bestsellerId: candidateId, error: outcome.error, linkVerified: true });
      }
      // Count as fully matched only after catalog synchronization and read-back verification.
      internalMatchedIds.push(candidateId);
      internalResults.push({
        bestsellerId: candidateId,
        supplierListingId: link.supplierListingId,
        supplyVariantId: link.supplyVariantId,
        linkStatus: link.linkStatus ?? null,
        reason: link.reason,
        canonicalLinkVerified: true,
        retryCleared: outcome.status === "linked",
        catalog: outcome.catalog,
      });
    }

    // Investigate one bestseller at a time and stop at a deadline. Supplier
    // adapters fan out into rate-limited calls, so a hard budget prevents a
    // 504 from killing the cron mid-flight and leaving the lock stale.
    const result = {
      processed: 0,
      matched: 0,
      rowErrors: 0,
      skippedNoIdentifier: 0,
      unconfigured: 0,
      noIdentifierOverlap: 0,
      supplyBarcodeMissing: 0,
      rowErrorDetails: [] as Awaited<ReturnType<typeof investigateDropshipForBestsellers>>["rowErrorDetails"],
      deferred: 0,
    };

    for (const [index, candidateId] of externalCandidateIds.entries()) {
      if (Date.now() - startedAt >= INVESTIGATION_BUDGET_MS) {
        result.deferred = externalCandidateIds.length - index;
        break;
      }

      const row = await investigateDropshipForBestsellers([candidateId]);
      result.processed += row.processed;
      result.matched += row.matched;
      result.rowErrors += row.rowErrors;
      result.skippedNoIdentifier += row.skippedNoIdentifier;
      result.unconfigured += row.unconfigured;
      result.noIdentifierOverlap += row.noIdentifierOverlap;
      result.supplyBarcodeMissing += row.supplyBarcodeMissing;
      result.rowErrorDetails.push(...row.rowErrorDetails);
    }

    const totalMatched = internalMatchedIds.length + result.matched;
    const metadata = {
      phase: "supplier_investigation",
      candidateCount: candidateIds.length,
      internalMatched: internalMatchedIds.length,
      internalLinkFailureCount: internalLinkFailures.length,
      internalLinkFailures,
      internalLinkErrors,
      internalLinkDiagnostics: {
        evaluated: Object.values(internalLinkReasonCounts).reduce((sum, count) => sum + count, 0),
        matched: internalMatchedIds.length,
        unmatched: Object.entries(internalLinkReasonCounts)
          .filter(([reason]) => !["canonical_link_saved", "canonical_link_existing_verified"].includes(reason))
          .reduce((sum, [, count]) => sum + count, 0),
        reasonCounts: internalLinkReasonCounts,
        linkStatusCounts: internalLinkStatusCounts,
        dueRetryQueueCount: dueRetryIds.length,
        pendingRetryQueueCount: retryStateRows?.length ?? 0,
      },
      externalCandidates: externalCandidateIds.length,
      externalMatched: result.matched,
      totalMatched,
      internalResults,
      skippedNoIdentifier: result.skippedNoIdentifier,
      unconfigured: result.unconfigured,
      noIdentifierOverlap: result.noIdentifierOverlap,
      supplyBarcodeMissing: result.supplyBarcodeMissing,
      rowErrors: result.rowErrors,
      deferred: result.deferred,
      // Sales-test publication, NEWFIND promotion, and BASE publication are
      // deliberately not chained here. Each has its own cron schedule.
    };

    if (cronRunId) {
      await supabase
        .from("cron_runs")
        .update({
          // Retry cleanup / persistence errors must not read as a clean run.
          status: internalLinkErrors.length > 0 ? "partial" : "succeeded",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          processed: candidateIds.length,
          failed: result.rowErrors + internalLinkErrors.length,
          metadata,
        })
        .eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: internalLinkErrors.length === 0,
      phase: "supplier_investigation",
      elapsedMs: Date.now() - startedAt,
      candidateIds,
      internalMatchedIds,
      internalResults,
      internalLinkFailureCount: internalLinkFailures.length,
      internalLinkFailures,
      internalLinkErrors,
      internalLinkDiagnostics: {
        evaluated: Object.values(internalLinkReasonCounts).reduce((sum, count) => sum + count, 0),
        matched: internalMatchedIds.length,
        reasonCounts: internalLinkReasonCounts,
        linkStatusCounts: internalLinkStatusCounts,
        dueRetryQueueCount: dueRetryIds.length,
        pendingRetryQueueCount: retryStateRows?.length ?? 0,
      },
      ...result,
      totalMatched,
      nextPhase: "sales_test_publication",
    });
  } catch (error) {
    if (cronRunId) {
      try {
        await supabase
          .from("cron_runs")
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          })
          .eq("id", cronRunId);
      } catch (recordError) {
        console.error("[TRACER CRON RUN RECORD ERROR]", recordError);
      }
    }

    console.error("[TRACER SUPPLIER INVESTIGATION CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "supplier_investigation",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
