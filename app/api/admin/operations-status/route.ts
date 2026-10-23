import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db
      .from("cron_runs")
      .select("id,job_name,status,started_at,finished_at,duration_ms,processed,failed,error")
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    const latestByJob = new Map<string, Record<string, unknown>>();
    for (const row of data ?? []) {
      const name = String(row.job_name ?? "unknown");
      if (!latestByJob.has(name)) latestByJob.set(name, row as Record<string, unknown>);
    }
    const now = Date.now();
    const jobs = [...latestByJob.values()].map((row) => {
      const started = Date.parse(String(row.started_at ?? ""));
      const status = String(row.status ?? "unknown");
      const ageMs = Number.isFinite(started) ? Math.max(0, now - started) : null;
      const staleRunning = status === "running" && ageMs !== null && ageMs > 10 * 60_000;
      return {
        jobName: row.job_name,
        status: staleRunning ? "stale" : status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs: row.duration_ms,
        processed: row.processed,
        failed: row.failed,
        error: typeof row.error === "string" ? row.error.slice(0, 300) : null,
        ageMs,
      };
    });
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      jobs,
      recentRuns: (data ?? []).slice(0, 30),
      source: "Supabase cron_runs",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "operations_status_read_failed",
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
