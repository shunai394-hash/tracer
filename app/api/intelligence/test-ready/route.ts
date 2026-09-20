import { NextResponse } from "next/server";
import { listOpportunities } from "@/lib/intelligence/opportunity-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const opportunities = await listOpportunities({
      state: "TEST_READY",
    });

    return NextResponse.json({
      ok: true,
      count: opportunities.length,
      opportunities,
    });
  } catch (error) {
    console.error("[TRACER TEST READY ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
