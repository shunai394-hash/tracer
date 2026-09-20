import { NextResponse } from "next/server";
import { startSalesTest } from "@/lib/intelligence/opportunity-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      opportunityId?: string;
      hypothesis?: string;
      channel?: string;
      testPrice?: number;
      budget?: number;
      successCriteria?: Record<string, unknown>;
    };

    if (!body.opportunityId) {
      return NextResponse.json(
        { ok: false, error: "opportunityId is required" },
        { status: 400 },
      );
    }

    const test = await startSalesTest(body.opportunityId, {
      hypothesis: body.hypothesis,
      channel: body.channel,
      testPrice: body.testPrice,
      budget: body.budget,
      successCriteria: body.successCriteria,
    });

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
