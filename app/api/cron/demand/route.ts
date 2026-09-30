import { NextResponse } from "next/server";
import { collectGoogleTrendsDemand } from "@/lib/intelligence/collect-google-trends";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;

    const result = await collectGoogleTrendsDemand();

    return NextResponse.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error("[TRACER DEMAND CRON ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
