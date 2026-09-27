import { NextResponse } from "next/server";
import { retryPendingNewfindPromotions } from "@/lib/integration/newfind";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const result = await retryPendingNewfindPromotions(50);
    return NextResponse.json({
      ok: true,
      phase: "newfind_retry",
      ...result,
    });
  } catch (error) {
    console.error("[TRACER NEWFIND RETRY CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "newfind_retry",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
