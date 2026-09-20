import { NextResponse } from "next/server";
import { matchDemandProductsByCategory } from "@/lib/intelligence/match-demand-products";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await matchDemandProductsByCategory();

    return NextResponse.json({
      ok: true,
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
