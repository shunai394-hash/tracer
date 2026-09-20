import { NextResponse } from "next/server";
import { collectGoogleTrendsDemand } from "@/lib/intelligence/collect-google-trends";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret) {
      if (authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json(
          {
            ok: false,
            error: "Unauthorized",
          },
          { status: 401 },
        );
      }
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
