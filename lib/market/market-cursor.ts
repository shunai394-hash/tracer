import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Db = ReturnType<typeof createSupabaseAdminClient>;

// Same cursor the market-sourcing cron persists: the latest succeeded
// market-sourcing cron_runs row carries { sourceIndex, nextIndex }.
const JOB = "market-sourcing";
const SOURCE_COUNT = 8;

export type MarketCursor = { sourceIndex: number; startIndex: number };

export async function readMarketCursor(db: Db): Promise<MarketCursor> {
  const { data, error } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", JOB)
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

/** Persist the position after an observation so the next run resumes there. */
export async function writeMarketCursor(
  db: Db,
  observation: { sourceIndex: number; nextIndex: number; hasMore: boolean; inserted: number; processedCount: number },
  actor: string,
): Promise<MarketCursor> {
  const next: MarketCursor = observation.hasMore
    ? { sourceIndex: observation.sourceIndex, startIndex: observation.nextIndex }
    : { sourceIndex: (observation.sourceIndex + 1) % SOURCE_COUNT, startIndex: 0 };
  const now = new Date().toISOString();
  const { error } = await db.from("cron_runs").insert({
    job_name: JOB,
    status: "succeeded",
    started_at: now,
    finished_at: now,
    processed: observation.inserted,
    failed: 0,
    metadata: {
      phase: "market_observation",
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
