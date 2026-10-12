import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizeMarketCursor } from "@/lib/market/market-cursor-policy";

type Db = ReturnType<typeof createSupabaseAdminClient>;

// Same cursor the market-sourcing cron persists: the latest succeeded
// market-sourcing cron_runs row carries { sourceIndex, nextIndex }.
const JOB = "market-sourcing";

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
  return normalizeMarketCursor(metadata.sourceIndex, metadata.nextIndex);
}
