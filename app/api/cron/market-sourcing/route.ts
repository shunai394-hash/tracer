import { NextResponse } from "next/server";
import { executeMarketSourcingCron } from "@/lib/ops/market-sourcing-cron";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

// Keep each observation invocation comfortably below Vercel's 60s hard limit.
// Market sourcing uses a bounded 10-item batch; larger catalogs resume through
// cron_runs.nextIndex on subsequent invocations. The 5-minute patrol repeats
// this stage, so reliability and complete ledger updates matter more than a
// large batch that can be terminated by the platform timeout.

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const result = await executeMarketSourcingCron(createSupabaseAdminClient(), maxDuration);
  return NextResponse.json(result.body, { status: result.httpStatus });
}
