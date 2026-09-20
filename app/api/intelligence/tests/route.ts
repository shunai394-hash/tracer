import { NextResponse } from "next/server";
import { startSalesTest } from "@/lib/intelligence/opportunity-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { opportunityId?: string };

    if (!body.opportunityId) {
      return NextResponse.json(
        { ok: false, error: "opportunityId is required" },
        { status: 400 },
      );
    }

    const test = await startSalesTest(body.opportunityId);

    return NextResponse.json({
      ok: true,
      test,
    });
  } catch (error) {
    console.error("[TRACER SALES TEST START ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 400 },
    );
  }
}
