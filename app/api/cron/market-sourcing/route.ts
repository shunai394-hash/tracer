import { NextResponse } from "next/server";
import { executeMarketSourcingCron } from "@/lib/ops/market-sourcing-cron";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

// Keep each observation invocation comfortably below Vercel's 60s hard limit.
// Larger batches are resumed through cron_runs.nextIndex on the next invocation.
// Process a meaningful slice on every patrol. The workflow repeats this stage
// several times so one hourly patrol can traverse multiple marketplace pages
// instead of advancing only a few rows and appearing to stall at one product.

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const result = await executeMarketSourcingCron(createSupabaseAdminClient(), maxDuration);
  return NextResponse.json(result.body, { status: result.httpStatus });
}
