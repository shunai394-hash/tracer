import { NextResponse } from "next/server";
import { getOpportunity } from "@/lib/intelligence/opportunity-store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const opportunity = await getOpportunity(id);

    if (!opportunity) {
      return NextResponse.json(
        { ok: false, error: "Opportunity not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      opportunity,
    });
  } catch (error) {
    console.error("[TRACER OPPORTUNITY DETAIL ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
