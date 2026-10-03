import { NextResponse } from "next/server";
import { matchDemandProductsByCategory } from "@/lib/intelligence/match-demand-products";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  let cronId: string | null = null;

  try {
    await recoverStaleCronRun(db, "demand-match", 180);

    const running = await db
      .from("cron_runs")
      .select("id,started_at")
      .eq("job_name", "demand-match")
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (running.error) throw new Error(running.error.message);
    if (running.data?.id) {
      return NextResponse.json({
        ok: true,
        status: "already_running",
        cronId: String(running.data.id),
      });
    }

    const created = await db
      .from("cron_runs")
      .insert({
        job_name: "demand-match",
        status: "running",
        metadata: { actor: "demand-match-cron", phase: "matching" },
      })
      .select("id")
      .single();

    if (created.error) {
      if (created.error.code === "23505") {
        return NextResponse.json({
          ok: true,
          status: "already_running",
          cronId: null,
        });
      }
      throw new Error(created.error.message);
    }

    cronId = String(created.data.id);
    const result = await matchDemandProductsByCategory();

    const status = result.persistErrors.length === 0 ? "succeeded" : "failed";
    const report = {
      ok: status === "succeeded",
      status,
      durationMs: Date.now() - startedAt,
      job: "demand-match",
      result,
    };

    await db
      .from("cron_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        duration_ms: report.durationMs,
        processed: result.processed,
        failed: result.persistErrors.length,
        error: result.persistErrors.length ? result.persistErrors.join("; ") : null,
        metadata: report,
      })
      .eq("id", cronId);

    return NextResponse.json(report, { status: status === "succeeded" ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (cronId) {
      await db
        .from("cron_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          error: message,
          metadata: { actor: "demand-match-cron", fatal: true },
        })
        .eq("id", cronId);
    }

    console.error("[TRACER DEMAND MATCH CRON ERROR]", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
