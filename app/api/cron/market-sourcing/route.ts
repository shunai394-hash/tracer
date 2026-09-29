import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
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

    // Keep this stage limited to market observation/persistence.
    // Supplier investigation, sales-test selection and NEWFIND delivery
    // run in separate cron stages so one request cannot consume the whole
    // 60-second serverless budget.
    const observation = await persistMarketplaceBestsellers();

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
