import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

// Keep each observation invocation comfortably below Vercel's 60s hard limit.
// Larger batches are resumed through cron_runs.nextIndex on the next invocation.
// Process a meaningful slice on every patrol. The workflow repeats this stage
// several times so one hourly patrol can traverse multiple marketplace pages
// instead of advancing only a few rows and appearing to stall at one product.
const MARKET_SOURCING_BATCH_SIZE = 200;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();
  const staleBefore = new Date(Date.now() - 120_000).toISOString();

  try {
    await supabase
      .from("cron_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: "Recovered stale running record after Vercel function timeout",
      })
      .eq("job_name", "market-sourcing")
      .eq("status", "running")
      .lt("started_at", staleBefore);

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
        return NextResponse.json(
          { ok: true, skipped: true, reason: "cron_already_running", job: "market-sourcing" },
          { status: 409 },
        );
      }
      throw new Error(cronClaimError.message);
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

    // This cron is observation-only. Supplier investigation, sales-test
    // publication, NEWFIND promotion, and BASE publication each have their
    // own scheduled stage. Keeping those stages separate prevents one slow
    // supplier/API call from consuming the market-observation 60s budget and
    // starving the next cron stage.
    const observation = await persistMarketplaceBestsellers({
      sourceIndex,
      startIndex,
      batchSize: MARKET_SOURCING_BATCH_SIZE,
    });

    const nextSourceIndex = observation.hasMore
      ? observation.sourceIndex
      : (observation.sourceIndex + 1) % 8;
    const nextStartIndex = observation.hasMore ? observation.nextIndex : 0;

    const evidenceWriteFailures = observation.canonicalVariantEvidenceWriteFailures;
    const evidenceWriteOk = evidenceWriteFailures === 0;
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
      canonicalVariantEvidenceParsed: observation.canonicalVariantEvidenceParsed,
      canonicalVariantEvidenceWritten: observation.canonicalVariantEvidenceWritten,
      canonicalVariantEvidenceWriteFailures: evidenceWriteFailures,
      canonicalVariantEvidenceWriteOk: evidenceWriteOk,
    };

    if (cronRunId) {
      const { error: runUpdateError } = await supabase
        .from("cron_runs")
        .update({
          status: evidenceWriteOk ? "succeeded" : "failed",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          processed: observation.inserted,
          failed: evidenceWriteFailures,
          error: evidenceWriteOk ? null : "canonical_variant_evidence_write_failed",
          metadata,
        })
        .eq("id", cronRunId);
      if (runUpdateError) throw new Error("cron_run_update_failed: " + runUpdateError.message);
    }

    const responseBody = {
      ok: evidenceWriteOk,
      phase: "market_observation",
      elapsedMs: Date.now() - startedAt,
      observation: {
        itemCount: observation.itemCount,
        inserted: observation.inserted,
        productsCreated: observation.productsCreated,
        supplierCandidateCount: observation.supplierCandidateIds.length,
        canonicalVariantEvidenceParsed: observation.canonicalVariantEvidenceParsed,
        canonicalVariantEvidenceWritten: observation.canonicalVariantEvidenceWritten,
        canonicalVariantEvidenceWriteFailures: evidenceWriteFailures,
        canonicalVariantEvidenceWriteOk: evidenceWriteOk,
        enrichment: observation.enrichment,
        sourceIndex: nextSourceIndex,
        startIndex: observation.startIndex,
        processedCount: observation.processedCount,
        nextIndex: nextStartIndex,
        hasMore: observation.hasMore,
      },
      nextPhase: evidenceWriteOk ? "supplier_investigation" : null,
    };
    if (!evidenceWriteOk) {
      // Do not advance the successful-run cursor when evidence persistence fails.
      // The same batch is retried idempotently on the next invocation.
      return NextResponse.json(responseBody, { status: 500 });
    }
    return NextResponse.json(responseBody);
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

    console.error("[TRACER MARKET SOURCING CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "market_observation",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
