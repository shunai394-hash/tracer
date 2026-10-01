import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
    await recoverStaleCronRun(supabase, "sales-test-publication", maxDuration);

    const { data: cronRun, error: claimError } = await supabase
      .from("cron_runs")
      .insert({
        job_name: "sales-test-publication",
        status: "running",
        metadata: { phase: "sales_test_publication" },
      })
      .select("id")
      .single();

    if (claimError) {
      if (claimError.code === "23505") {
        return NextResponse.json(
          { ok: true, skipped: true, reason: "cron_already_running", job: "sales-test-publication" },
          { status: 409 },
        );
      }
      throw new Error(claimError.message);
    }

    cronRunId = cronRun?.id ? String(cronRun.id) : null;

    // Supply-first is the primary autonomous sales path. The manual
    // /api/intelligence/bestsellers endpoint already uses this path, but the
    // scheduled pipeline previously skipped it entirely, leaving BASE at the
    // first manually discovered item. Reuse the same live CJ gates here.
    // Bound CJ discovery so the rest of this stage (and the cron_runs
    // bookkeeping) finishes inside maxDuration; unbounded, the function was
    // killed and left the lock held.
    await discoverAndCreateCjSupply(20, {
      deadlineAt: startedAt + 150_000,
    });
    // Supply-first only verifies supplier availability.
    // It never publishes directly; publication remains behind the sales-test gate.
    const { data: readyRows, error: readyError } = await supabase
      .from("marketplace_bestsellers")
      .select("id")
      .eq("pipeline_stage", "VARIANT_VERIFIED")
      .eq("pipeline_status", "ready")
      .order("fetched_at", { ascending: false })
      .limit(10);

    if (readyError) throw new Error(readyError.message);

    const candidateIds = (readyRows ?? []).map((row) => String(row.id));
    const decision = await selectAndPublishSalesTests(candidateIds, 10);

    if (cronRunId) {
      await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: candidateIds.length,
        failed: 0,
        metadata: {
          phase: "sales_test_publication",
          mode: "market_linked_sales_test",
          considered: decision.considered,
          published: decision.published,
        },
      }).eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: true,
      phase: "sales_test_publication",
      elapsedMs: Date.now() - startedAt,
      mode: "market_linked_sales_test",
      candidateCount: candidateIds.length,
      decision,
      nextPhase: "downstream_delivery",
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

    console.error("[TRACER SALES TEST PUBLICATION CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "sales_test_publication",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
