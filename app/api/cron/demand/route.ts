import { NextResponse } from "next/server";
import { collectGoogleTrendsDemand } from "@/lib/intelligence/collect-google-trends";
import { isCronAuthorized } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

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
