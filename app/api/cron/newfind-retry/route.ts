import { NextResponse } from "next/server";
import { retryPendingNewfindPromotions } from "@/lib/integration/newfind";
import { rescueUndeliveredGatePassedListings, withdrawUnpublishedNewfindPromotions } from "@/lib/integration/newfind-reconcile";
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
    const startedAt = Date.now();
    const result = await retryPendingNewfindPromotions(1);
    // Also rescue gate-passed (usually BASE-listed) listings that have no
    // delivery row at all, which the delivery-row retry above cannot see.
    const rescue = await rescueUndeliveredGatePassedListings({
      limit: 2,
      deadlineAt: startedAt + 40_000,
    });
    // Withdraw NEWFIND promotions of listings TRACER no longer publishes.
    // Opt-in (NEWFIND_WITHDRAW_RECONCILE=1); reports enabled:false otherwise.
    const withdraw = Date.now() < startedAt + 45_000
      ? await withdrawUnpublishedNewfindPromotions({ limit: 5 })
      : { enabled: false, skipped: "time_budget" };
    return NextResponse.json({
      ok: true,
      phase: "newfind_retry",
      ...result,
      rescue,
      withdraw,
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
