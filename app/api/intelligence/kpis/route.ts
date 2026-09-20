import { NextResponse } from "next/server";
import { getOpportunityKpis } from "@/lib/intelligence/opportunity-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const kpis = await getOpportunityKpis();

    return NextResponse.json({
      ok: true,
      kpis,
    });
  } catch (error) {
    console.error("[TRACER OPPORTUNITY KPI ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
