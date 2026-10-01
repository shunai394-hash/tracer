import { NextResponse } from "next/server";
import { retryPendingNewfindPromotions } from "@/lib/integration/newfind";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;

    // Each delivery can perform multiple external requests and liveness checks.
    // Keep one delivery per invocation so the 60s function ceiling cannot be
    // consumed by a large retry batch. The workflow runs every 20 minutes and
    // drains the queue incrementally.
    const result = await retryPendingNewfindPromotions(1);
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
