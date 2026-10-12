import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Db = ReturnType<typeof createSupabaseAdminClient>;

// market-sourcing and patrol-ai are independently scheduled. Keep their
// cursors in separate cron_runs namespaces so one worker cannot rewind the
// other's progress when their invocations overlap.
const SOURCE_COUNT = 8;
const CURSOR_JOB_BY_ACTOR: Record<string, string> = {
  "market-sourcing": "market-sourcing",
  "patrol-ai": "patrol-ai-market-cursor",
};

function cursorJob(actor: string): string {
  const job = CURSOR_JOB_BY_ACTOR[actor];
  if (!job) throw new Error(`unsupported market cursor actor: ${actor}`);
  return job;
}

export type MarketCursor = { sourceIndex: number; startIndex: number };

export async function readMarketCursor(db: Db, actor: string): Promise<MarketCursor> {
  const job = cursorJob(actor);
  const { data, error } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", job)
    .eq("status", "succeeded")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`market cursor read failed: ${error.message}`);
  const metadata = (data?.metadata ?? {}) as Record<string, unknown>;
  const sourceIndex = Number(metadata.sourceIndex);
  const nextIndex = Number(metadata.nextIndex);
  return {
    sourceIndex: Number.isInteger(sourceIndex) && sourceIndex >= 0 ? sourceIndex % SOURCE_COUNT : 0,
    startIndex: Number.isInteger(nextIndex) && nextIndex >= 0 ? nextIndex : 0,
  };
}

/** Persist the position after an observation in this actor's own cursor namespace. */
export async function writeMarketCursor(
  db: Db,
  observation: { sourceIndex: number; nextIndex: number; hasMore: boolean; inserted: number; processedCount: number },
  actor: string,
): Promise<MarketCursor> {
  const job = cursorJob(actor);
  const next: MarketCursor = observation.hasMore
    ? { sourceIndex: observation.sourceIndex, startIndex: observation.nextIndex }
    : { sourceIndex: (observation.sourceIndex + 1) % SOURCE_COUNT, startIndex: 0 };
  const now = new Date().toISOString();
  const { error } = await db.from("cron_runs").insert({
    job_name: job,
    status: "succeeded",
    started_at: now,
    finished_at: now,
    processed: observation.inserted,
    failed: 0,
    metadata: {
      phase: "market_observation_cursor",
      actor,
      sourceIndex: next.sourceIndex,
      nextIndex: next.startIndex,
      processedCount: observation.processedCount,
      hasMore: observation.hasMore,
    },
  });
  if (error) throw new Error(`market cursor write failed: ${error.message}`);
  return next;
}
