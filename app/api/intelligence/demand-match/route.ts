import { NextResponse } from "next/server";
import { matchDemandProductsByCategory } from "@/lib/intelligence/match-demand-products";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

// Both Vercel Cron (GET) and authenticated manual/automation calls (POST)
// use the same guarded handler. This route writes demand matches/candidates.
async function runDemandMatch(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const result = await matchDemandProductsByCategory();

    return NextResponse.json({
      ok: result.persistErrors.length === 0,
      result,
    });
  } catch (error) {
    console.error("[TRACER DEMAND MATCH ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// Vercel Cron invokes scheduled routes with GET and CRON_SECRET authorization.
export async function GET(request: Request) {
  return runDemandMatch(request);
}

export async function POST(request: Request) {
  return runDemandMatch(request);
}
