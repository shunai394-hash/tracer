import { NextResponse } from "next/server";
import { matchDemandProductsByCategory } from "@/lib/intelligence/match-demand-products";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

// Writes demand_product_matches / demand_product_candidates, so it requires
// the same automation auth as the cron routes (it was previously open).
export async function POST(request: Request) {
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
