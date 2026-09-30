import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * A Vercel timeout kills the function before it can mark its cron_runs row
 * finished, and the one-running-row unique index then answers every later
 * invocation with 409 cron_already_running. Reclaim rows older than the
 * route's own maxDuration before claiming the lock.
 */
export async function recoverStaleCronRun(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  jobName: string,
  maxDurationSeconds: number,
): Promise<void> {
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
  if (error) console.error("[cron-lock] stale run recovery failed", { jobName, error: error.message });
}
