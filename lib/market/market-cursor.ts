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


/** Pure cursor transition: only the market-sourcing cron is allowed to persist it. */
export function nextMarketCursor(observation: {
  sourceIndex: number;
  nextIndex: number;
  hasMore: boolean;
}): MarketCursor {
  return observation.hasMore
    ? {
        sourceIndex: Math.max(0, observation.sourceIndex) % SOURCE_COUNT,
        startIndex: Math.max(0, observation.nextIndex),
      }
    : {
        sourceIndex: (Math.max(0, observation.sourceIndex) + 1) % SOURCE_COUNT,
        startIndex: 0,
      };
}
