import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { reverifyCjSupplyIdentities } from "@/lib/suppliers/reverify-cj-identity";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Identity re-verification is deliberately isolated from the full intelligence
 * pipeline. A slow marketplace/demand stage must never consume the budget that
 * turns an already orderable CJ variant into identifier-grade canonical supply.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const startedAt = Date.now();
  try {
    const result = await reverifyCjSupplyIdentities({
      limit: 50,
      // Keep a hard safety margin, but do not inherit a caller's earlier
      // pipeline deadline. This job owns the full function budget.
      deadlineAt: startedAt + 240_000,
    });

    return NextResponse.json({
      ok: result.errors.length === 0,
      phase: "cj_identity_reverify",
      elapsedMs: Date.now() - startedAt,
      ...result,
      next: "sales_test_publication",
    }, { status: result.errors.length === 0 ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "cj_identity_reverify",
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
