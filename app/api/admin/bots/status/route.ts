import { NextResponse } from "next/server";
import { buildCommerceBotStatusReport } from "@/lib/agents/commerce-bot-control-plane";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authenticated read-only status endpoint for the five commerce bots.
 * It reports configuration and integration points; it does not invoke jobs,
 * mutate Supabase, or write to BASE, Shopify, or NEWFIND.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  return NextResponse.json(buildCommerceBotStatusReport(process.env), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
