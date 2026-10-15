import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

// Observation only: this cron collects market demand and canonical child-variant
// evidence. It never publishes a marketplace ranking item or creates supplier orders.
const MARKET_SOURCING_BATCH_SIZE = 50;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  const staleBefore = new Date(Date.now() - 120_000).toISOString();
  let cronRunId: string | null = null;

  try {
    await db.from("cron_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: "Recovered stale running record after market-sourcing timeout",
      })
      .eq("job_name", "market-sourcing-observation")
      .eq("status", "running")
      .lt("started_at", staleBefore);

    const { data: run, error: claimError } = await db.from("cron_runs").insert({
      job_name: "market-sourcing-observation",
      status: "running",
      metadata: { phase: "market_observation", actor: "vercel-cron" },
    }).select("id").single();

    if (claimError) {
      if (claimError.code === "23505") {
        return NextResponse.json({ ok: true, skipped: true, reason: "cron_already_running", job: "market-sourcing-observation" }, { status: 409 });
      }
      throw new Error(`market_sourcing_run_create_failed:${claimError.message}`);
    }
    cronRunId = run?.id ? String(run.id) : null;

    const { data: previousRun, error: previousRunError } = await db.from("cron_runs")
      .select("metadata")
      .eq("job_name", "market-sourcing-observation")
      .eq("status", "succeeded")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previousRunError) throw new Error(`market_sourcing_cursor_read_failed:${previousRunError.message}`);

    const previousMetadata = previousRun?.metadata;
    const metadataObject = previousMetadata && typeof previousMetadata === "object" && !Array.isArray(previousMetadata)
      ? previousMetadata as Record<string, unknown>
      : {};
    const sourceIndex = typeof metadataObject.sourceIndex === "number" ? Math.max(0, metadataObject.sourceIndex) : 0;
    const startIndex = typeof metadataObject.sourceIndex === "number" && typeof metadataObject.nextIndex === "number"
      ? Math.max(0, metadataObject.nextIndex)
      : 0;

    const observation = await persistMarketplaceBestsellers({
      sourceIndex,
      startIndex,
      batchSize: MARKET_SOURCING_BATCH_SIZE,
    });
    const nextSourceIndex = observation.hasMore ? observation.sourceIndex : (observation.sourceIndex + 1) % 8;
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
      actor: "vercel-cron",
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
      canonicalVariantEvidenceWriteFailures: observation.canonicalVariantEvidenceWriteFailures,
      canonicalVariantEvidenceStatus,
    };

    if (cronRunId) {
      const { error: finishError } = await db.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: observation.inserted,
        failed: observation.canonicalVariantEvidenceWriteFailures,
        metadata,
      }).eq("id", cronRunId);
      if (finishError) throw new Error(`market_sourcing_run_finish_failed:${finishError.message}`);
    }

    return NextResponse.json({
      ok: true,
      phase: "market_observation",
      elapsedMs: Date.now() - startedAt,
      observation: {
        itemCount: observation.itemCount,
        inserted: observation.inserted,
        productsCreated: observation.productsCreated,
        supplierCandidateCount: observation.supplierCandidateIds.length,
        enrichment: observation.enrichment,
        canonicalVariantEvidenceParsed: observation.canonicalVariantEvidenceParsed,
        canonicalVariantEvidenceWritten: observation.canonicalVariantEvidenceWritten,
        canonicalVariantEvidenceWriteFailures: observation.canonicalVariantEvidenceWriteFailures,
        canonicalVariantEvidenceStatus,
        sourceIndex: nextSourceIndex,
        startIndex: observation.startIndex,
        processedCount: observation.processedCount,
        nextIndex: nextStartIndex,
        hasMore: observation.hasMore,
      },
      publication: { published: 0, ordersPlaced: 0, reason: "observation_only" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (cronRunId) {
      const { error: finishError } = await db.from("cron_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        error: message.slice(0, 2000),
      }).eq("id", cronRunId);
      if (finishError) console.error("[TRACER MARKET SOURCING RUN UPDATE FAILED]", finishError.message);
    }
    console.error("[TRACER MARKET SOURCING CRON ERROR]", message);
    return NextResponse.json({ ok: false, phase: "market_observation", error: message }, { status: 500 });
  }
}
