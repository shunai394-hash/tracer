import "server-only";

import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { recoverStaleCronRun, writeCronLedger } from "@/lib/ops/cron-lock";
import { assessCountedCronResult } from "@/lib/ops/publication-cron-report";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

const MARKET_SOURCING_BATCH_SIZE = 10;

export async function executeMarketSourcingCron(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  maxDurationSeconds = 60,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
    const recovery = await recoverStaleCronRun(supabase, "market-sourcing", maxDurationSeconds);
    if (!recovery.ok) {
      const recorded = await supabase.from("cron_runs").insert({
        job_name: "market-sourcing",
        status: "failed",
        finished_at: new Date().toISOString(),
        failed: 1,
        error: recovery.error,
        metadata: { reason: "cron_lock_recovery_failed" },
      }).select("id").single();
      return {
        httpStatus: 500,
        body: {
          ok: false,
          reason: "cron_lock_recovery_failed",
          error: recovery.error,
          job: "market-sourcing",
          ledgerUpdateFailed: Boolean(recorded.error),
        },
      };
    }

    const { data: cronRun, error: cronClaimError } = await supabase
      .from("cron_runs")
      .insert({
        job_name: "market-sourcing",
        status: "running",
        metadata: { phase: "market_observation" },
      })
      .select("id")
      .single();

    if (cronClaimError) {
      if (cronClaimError.code === "23505") {
        return {
          httpStatus: 409,
          body: { ok: false, skipped: true, reason: "cron_already_running", job: "market-sourcing" },
        };
      }
      return {
        httpStatus: 500,
        body: {
          ok: false,
          reason: "cron_lock_claim_failed",
          error: cronClaimError.message,
          job: "market-sourcing",
        },
      };
    }

    cronRunId = cronRun?.id ? String(cronRun.id) : null;

    const { data: previousRun, error: previousRunError } = await supabase
      .from("cron_runs")
      .select("metadata")
      .eq("job_name", "market-sourcing")
      .eq("status", "succeeded")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (previousRunError) throw new Error(previousRunError.message);

    const previousMetadata = previousRun?.metadata;
    const metadataObject =
      previousMetadata && typeof previousMetadata === "object" && !Array.isArray(previousMetadata)
        ? (previousMetadata as Record<string, unknown>)
        : null;
    const sourceIndex =
      metadataObject && typeof metadataObject.sourceIndex === "number"
        ? Math.max(0, Number(metadataObject.sourceIndex))
        : 0;
    const startIndex =
      metadataObject &&
      typeof metadataObject.sourceIndex === "number" &&
      typeof metadataObject.nextIndex === "number"
        ? Math.max(0, Number(metadataObject.nextIndex))
        : 0;

    const observation = await persistMarketplaceBestsellers({
      sourceIndex,
      startIndex,
      batchSize: MARKET_SOURCING_BATCH_SIZE,
    });

    const nextSourceIndex = observation.hasMore
      ? observation.sourceIndex
      : (observation.sourceIndex + 1) % 8;
    const nextStartIndex = observation.hasMore ? observation.nextIndex : 0;

    const canonicalVariantEvidenceStatus = observation.canonicalVariantEvidenceWriteFailures > 0
      ? "write_failed"
      : observation.canonicalVariantEvidenceParsed === 0
        ? "no_canonical_variant_evidence"
        : observation.canonicalVariantEvidenceWritten === observation.canonicalVariantEvidenceParsed
          ? "persisted"
          : "incomplete";
    const metadata = {
      phase: "market_observation",
      itemCount: observation.itemCount,
      inserted: observation.inserted,
      batchSize: MARKET_SOURCING_BATCH_SIZE,
      sourceIndex: nextSourceIndex,
      startIndex: observation.startIndex,
      processedCount: observation.processedCount,
      nextIndex: nextStartIndex,
      hasMore: observation.hasMore,
      enrichment: observation.enrichment,
      supplierCandidateCount: observation.supplierCandidateIds.length,
      skippedMarketplaces: observation.skippedMarketplaces,
      failedMarketplaces: observation.failedMarketplaces,
      canonicalVariantEvidenceParsed: observation.canonicalVariantEvidenceParsed,
      canonicalVariantEvidenceWritten: observation.canonicalVariantEvidenceWritten,
      canonicalVariantEvidenceWriteFailures: observation.canonicalVariantEvidenceWriteFailures,
      canonicalVariantEvidenceStatus: canonicalVariantEvidenceStatus,
      failed: observation.canonicalVariantEvidenceWriteFailures + observation.failedMarketplaces.length,
    };

    const workFailed = observation.canonicalVariantEvidenceWriteFailures + observation.failedMarketplaces.length;
    const preliminary = assessCountedCronResult({ processed: observation.inserted, failed: workFailed });
    const ledger = await writeCronLedger(supabase, cronRunId, {
      status: preliminary.cronStatus,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      processed: observation.inserted,
      failed: workFailed,
      metadata,
    });
    const report = assessCountedCronResult({
      processed: observation.inserted,
      failed: workFailed,
      ledgerUpdateFailed: !ledger.ok,
    });

    return {
      httpStatus: report.httpStatus,
      body: {
        ok: report.ok,
        reason: report.reasons[0] ?? null,
        phase: "market_observation",
        elapsedMs: Date.now() - startedAt,
        failed: report.failed,
        cronStatus: report.cronStatus,
        ledgerUpdateFailed: !ledger.ok,
        ledgerError: ledger.error,
        observation: {
          itemCount: observation.itemCount,
          inserted: observation.inserted,
          productsCreated: observation.productsCreated,
          supplierCandidateCount: observation.supplierCandidateIds.length,
          enrichment: observation.enrichment,
          canonicalVariantEvidenceParsed: observation.canonicalVariantEvidenceParsed,
          canonicalVariantEvidenceWritten: observation.canonicalVariantEvidenceWritten,
          canonicalVariantEvidenceWriteFailures: observation.canonicalVariantEvidenceWriteFailures,
          canonicalVariantEvidenceStatus: canonicalVariantEvidenceStatus,
          sourceIndex: nextSourceIndex,
          startIndex: observation.startIndex,
          processedCount: observation.processedCount,
          nextIndex: nextStartIndex,
          hasMore: observation.hasMore,
        },
        nextPhase: "supplier_investigation",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ledger = await writeCronLedger(supabase, cronRunId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      failed: 1,
      error: message,
    });
    console.error("[TRACER MARKET SOURCING CRON ERROR]", error);
    if (!ledger.ok) console.error("[TRACER CRON RUN RECORD ERROR]", ledger.error);
    return {
      httpStatus: 500,
      body: {
        ok: false,
        reason: "market_sourcing_failed",
        phase: "market_observation",
        error: message,
        ledgerUpdateFailed: !ledger.ok,
        ledgerError: ledger.error,
      },
    };
  }
}
