import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { getMarketSourcingCursor } from "@/lib/market/market-sourcing-cursor";
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
      .in("status", ["succeeded", "failed"])
      .not("metadata->>sourceIndex", "is", null)
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
    const evidenceWriteFailed =
      !observation.canonicalVariantEvidenceSchemaAvailable ||
      observation.canonicalVariantEvidenceWriteFailures > 0;
    // Do not persist an advanced cursor for a failed evidence batch. The next
    // invocation must retry this exact source/page until evidence is durable.
    const cursor = getMarketSourcingCursor({
      evidenceWriteFailed,
      currentSourceIndex: observation.sourceIndex,
      nextSourceIndex,
      currentStartIndex: observation.startIndex,
      nextStartIndex,
    });
    const cursorSourceIndex = cursor.sourceIndex;
    const cursorNextIndex = cursor.nextIndex;

    const metadata = {
      phase: "market_observation",
      itemCount: observation.itemCount,
      inserted: observation.inserted,
      batchSize: MARKET_SOURCING_BATCH_SIZE,
      sourceIndex: cursorSourceIndex,
      startIndex: observation.startIndex,
      processedCount: observation.processedCount,
      nextIndex: cursorNextIndex,
      hasMore: observation.hasMore,
      enrichment: observation.enrichment,
      supplierCandidateCount: observation.supplierCandidateIds.length,
      canonicalVariantEvidenceSchemaAvailable: observation.canonicalVariantEvidenceSchemaAvailable,
      canonicalVariantEvidenceParsed: observation.canonicalVariantEvidenceParsed,
      canonicalVariantEvidenceWritten: observation.canonicalVariantEvidenceWritten,
      canonicalVariantEvidenceWriteFailures: observation.canonicalVariantEvidenceWriteFailures,
      canonicalVariantEvidenceStatus: !observation.canonicalVariantEvidenceSchemaAvailable
        ? "schema_unavailable"
        : observation.canonicalVariantEvidenceWriteFailures > 0
          ? "write_failed"
          : "ok",
    };
    if (cronRunId) {
      await supabase
        .from("cron_runs")
        .update({
          status: evidenceWriteFailed ? "failed" : "succeeded",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          processed: observation.inserted,
          failed: observation.canonicalVariantEvidenceWriteFailures +
            (observation.canonicalVariantEvidenceSchemaAvailable ? 0 : 1),
          error: evidenceWriteFailed
            ? "Canonical marketplace variant evidence was not fully persisted"
            : null,
          metadata,
        })
        .eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: !evidenceWriteFailed,
      phase: "market_observation",
      elapsedMs: Date.now() - startedAt,
      observation: {
        itemCount: observation.itemCount,
        inserted: observation.inserted,
        productsCreated: observation.productsCreated,
        supplierCandidateCount: observation.supplierCandidateIds.length,
        canonicalVariantEvidenceSchemaAvailable: observation.canonicalVariantEvidenceSchemaAvailable,
        canonicalVariantEvidenceParsed: observation.canonicalVariantEvidenceParsed,
        canonicalVariantEvidenceWritten: observation.canonicalVariantEvidenceWritten,
        canonicalVariantEvidenceWriteFailures: observation.canonicalVariantEvidenceWriteFailures,
        canonicalVariantEvidenceStatus: metadata.canonicalVariantEvidenceStatus,
        enrichment: observation.enrichment,
        sourceIndex: cursorSourceIndex,
        startIndex: cursorNextIndex,
        processedCount: observation.processedCount,
        nextIndex: cursorNextIndex,
        hasMore: observation.hasMore,
      },
      nextPhase: "supplier_investigation",
    }, { status: evidenceWriteFailed ? 500 : 200 });
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
