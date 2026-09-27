import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Market observation only.
 * This endpoint never investigates suppliers and never publishes/unpublishes shop listings.
 */
export async function POST() {
  try {
    const startedAt = Date.now();
    const observation = await persistMarketplaceBestsellers();

    return NextResponse.json({
      ok: true,
      phase: "market_observation",
      elapsedMs: Date.now() - startedAt,
      observation,
      sourcingDecision: "not_run",
      publication: "not_run",
    });
  } catch (error) {
    console.error("[TRACER MARKET OBSERVATION ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "market_observation",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
