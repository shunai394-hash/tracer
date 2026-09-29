import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const MARKET_SOURCING_BATCH_SIZE = 50;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();
  // Vercel terminates this function at maxDuration. If that happens before
  // the finally/update path runs, the singleton row would otherwise block the
  // next scheduled run forever. A run cannot legitimately exceed this TTL.
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

    // Keep this stage bounded. One full bestseller collection can contain
    // thousands of rows, while each row requires several Supabase writes.
    // Persist a deterministic batch per invocation and carry the cursor in
    // cron_runs metadata so a timeout never advances the cursor prematurely.
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
    const startIndex =
      previousMetadata && typeof previousMetadata === "object" && !Array.isArray(previousMetadata) &&
      typeof (previousMetadata as Record<string, unknown>).nextIndex === "number"
        ? Math.max(0, Number((previousMetadata as Record<string, unknown>).nextIndex))
        : 0;

    const observation = await persistMarketplaceBestsellers({
      startIndex,
      batchSize: MARKET_SOURCING_BATCH_SIZE,
    });

    if (cronRunId) {
      await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: observation.inserted,
        failed: 0,
        metadata: {
          phase: "market_observation",
          itemCount: observation.itemCount,
          inserted: observation.inserted,
          supplierCandidateCount: observation.supplierCandidateIds.length,
          batchSize: MARKET_SOURCING_BATCH_SIZE,
          startIndex: observation.startIndex,
          processedCount: observation.processedCount,
          nextIndex: observation.hasMore ? observation.nextIndex : 0,
          hasMore: observation.hasMore,
        },
      }).eq("id", cronRunId);
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
        startIndex: observation.startIndex,
        processedCount: observation.processedCount,
        nextIndex: observation.hasMore ? observation.nextIndex : 0,
        hasMore: observation.hasMore,
      },
      nextPhase: "supplier_investigation",
    });
  } catch (error) {
    if (cronRunId) {
      try {
        await supabase.from("cron_runs").update({
          status: "failed",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }).eq("id", cronRunId);
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
