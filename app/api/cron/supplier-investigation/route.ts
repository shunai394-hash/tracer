import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";
import { linkInternalSupplyForBestseller } from "@/lib/suppliers/internal-catalog";
import { syncTracerCatalogFromInternalSupply } from "@/lib/suppliers/sync-tracer-catalog";

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

    let candidateIds = prioritizeRows(
      (freshRows ?? []) as unknown as Record<string, unknown>[],
    )
      .slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE)
      .map((row) => String(row.id));

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
      ).slice(0, retrySlots);

      candidateIds = [...candidateIds, ...prioritizedRetries.map((row) => String(row.id))]
        .filter((id, index, ids) => ids.indexOf(id) === index);
    }

    const internalMatchedIds: string[] = [];
    const internalResults: Record<string, unknown>[] = [];
    const externalCandidateIds: string[] = [];
    const internalLinkReasonCounts: Record<string, number> = {};
    const internalLinkStatusCounts: Record<string, number> = {};

    for (const candidateId of candidateIds) {
      const { data: bestseller, error } = await supabase
        .from("marketplace_bestsellers")
        .select("*")
        .eq("id", candidateId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!bestseller) {
        externalCandidateIds.push(candidateId);
        continue;
      }

      const internal = await linkInternalSupplyForBestseller({
        bestseller: bestseller as Record<string, unknown>,
        fetchedAt: String(bestseller.fetched_at ?? new Date().toISOString()),
      });
      internalLinkReasonCounts[internal.reason] = (internalLinkReasonCounts[internal.reason] ?? 0) + 1;
      if (internal.linkStatus) {
        internalLinkStatusCounts[internal.linkStatus] = (internalLinkStatusCounts[internal.linkStatus] ?? 0) + 1;
      }

      if (!internal.matched) {
        externalCandidateIds.push(candidateId);
        continue;
      }

      internalMatchedIds.push(candidateId);
      const catalog = await syncTracerCatalogFromInternalSupply({
        bestsellerId: candidateId,
        salePrice: Number.isFinite(Number(bestseller.price)) ? Number(bestseller.price) : null,
        variantIds: internal.supplyVariantId ? [internal.supplyVariantId] : [],
      });
      internalResults.push({
        bestsellerId: candidateId,
        supplierListingId: internal.supplierListingId,
        catalog,
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
    const internalLinkDiagnostics = {
      evaluated: Object.values(internalLinkReasonCounts).reduce((sum, count) => sum + count, 0),
      matched: internalMatchedIds.length,
      unmatched: Object.entries(internalLinkReasonCounts)
        .filter(([reason]) => !["canonical_link_saved", "canonical_link_existing_verified"].includes(reason))
        .reduce((sum, [, count]) => sum + count, 0),
      reasonCounts: internalLinkReasonCounts,
      linkStatusCounts: internalLinkStatusCounts,
    };
    const metadata = {
      phase: "supplier_investigation",
      candidateCount: candidateIds.length,
      internalMatched: internalMatchedIds.length,
      externalCandidates: externalCandidateIds.length,
      externalMatched: result.matched,
      totalMatched,
      internalResults,
      internalLinkDiagnostics,
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
          status: "succeeded",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          processed: candidateIds.length,
          failed: result.rowErrors,
          metadata,
        })
        .eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: true,
      phase: "supplier_investigation",
      elapsedMs: Date.now() - startedAt,
      candidateIds,
      internalMatchedIds,
      internalResults,
      internalLinkDiagnostics,
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
