import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * A Vercel timeout kills the function before it can mark its cron_runs row
 * finished, and the one-running-row unique index then answers every later
 * invocation with 409 and ok:false cron_already_running. Reclaim rows older than the
 * route's own maxDuration before claiming the lock.
 */
export type CronLockRecovery = { ok: true; error: null } | { ok: false; error: string };

export async function recoverStaleCronRun(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  jobName: string,
  maxDurationSeconds: number,
): Promise<CronLockRecovery> {
  const staleBefore = new Date(Date.now() - (maxDurationSeconds + 30) * 1000).toISOString();
  const { error } = await supabase
    .from("cron_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: "Recovered stale running record after Vercel function timeout",
    })
    .eq("job_name", jobName)
    .eq("status", "running")
    .lt("started_at", staleBefore);
  if (error) {
    console.error("[cron-lock] stale run recovery failed", { jobName, error: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true, error: null };
}

export async function writeCronLedger(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  cronRunId: string | null,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; error: string | null }> {
  if (!cronRunId) return { ok: false, error: "cron_run_id_missing" };
  try {
    const { error } = await supabase.from("cron_runs").update(patch).eq("id", cronRunId);
    if (error) return { ok: false, error: error.message };
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Cleanup failures are reported beside the original failure. They do not
 * replace it, and a cleanup exception is not a successful run.
 */
export async function preservePrimaryFailure<T>(
  primary: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<{ value: T | null; error: unknown; cleanupError: unknown }> {
  let value: T | null = null;
  let error: unknown = null;
  try {
    value = await primary();
  } catch (caught) {
    error = caught;
  }
  let cleanupError: unknown = null;
  try {
    await cleanup();
  } catch (caught) {
    cleanupError = caught;
    console.error("[cron-lock] cleanup failed", caught instanceof Error ? caught.message : String(caught));
  }
  return { value: error ? null : value, error, cleanupError };
}
